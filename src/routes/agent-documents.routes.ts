import { Router, type Request } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { Agent } from '@prisma/client';
import {
  confirmDocument,
  createDocumentUpload,
  createParagraphDocument,
  createWebLinkDocument,
  deleteDocument,
  getAgentDocuments,
  getDocumentSyncStatus,
  linkDocuments,
  putToPresignedUrl,
  unlinkDocument,
  type UpstreamRecord,
} from '../adapter/vocobase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireMembership, workspaceOf } from '../middleware/workspace.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { parseBody } from '../lib/validate.js';
import { writeLimiter } from '../lib/writeLimiter.js';
import { readString } from '../lib/upstream.js';
import { serializeAgentDocuments } from '../lib/serialize.js';
import { claimCreated, resourceInWorkspace, unmapResource } from '../lib/workspaceResource.js';

/**
 * An agent's knowledge base.
 *
 * A document is a **partner-level** resource upstream: it is created once and
 * then linked to an agent, and the same document can be linked to several.
 * That is why every source created here is mapped to the creating workspace in
 * the same request — without a mapping it would be a row in a shared namespace
 * that nobody could prove ownership of, and so nobody could ever remove.
 *
 * Three kinds of source, one shape. A file costs four upstream calls (presign,
 * PUT, confirm, link); pasted text and a web link produce a ready document in
 * one and then link it. The difference is entirely in how the document comes
 * into existence, so only that part differs below.
 */
export const agentDocumentRoutes: Router = Router();

/**
 * 25MB, and deliberately lower than the 50MB the platform accepts.
 *
 * The file is held whole in this process's memory on its way to the presigned
 * URL, so the ceiling is a property of this service rather than of the
 * platform's storage. Raising it means deciding this process can afford it.
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * The platform's own accepted set, restated.
 *
 * Checked here so an unsupported file fails immediately with a message naming
 * what is allowed, rather than being uploaded in full and rejected at the
 * confirm step with a generic one.
 *
 * **A convenience, not a control.** `file.mimetype` is the `Content-Type` the
 * client put on the multipart part, so it is whatever the caller says it is —
 * `curl -F 'file=@x.exe;type=application/pdf'` passes this. Nothing here reads
 * the bytes. What actually bounds the risk is the size cap, the fact the file
 * is streamed to a presigned URL and never executed or stored by this service,
 * and upstream's own check at the confirm step. Treating this list as the
 * defence would be a mistake.
 */
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
]);

const upload = multer({
  // In memory, not on disk: the bytes are forwarded straight to the presigned
  // URL and never belong to this service. A temp file would be one more place
  // a customer's document could be left behind.
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
    // `fileSize` alone caps the *file* part. Multer's defaults leave `fields`
    // and `parts` at Infinity, so a request carrying no file at all — just
    // text fields — was bounded by nothing and buffered until the process
    // died, taking every other tenant with it. Since the memory ceiling is the
    // security control this route documents, it has to cover the whole body
    // and not only the part that happens to be a file.
    fields: 4,
    parts: 6,
    fieldNameSize: 100,
    fieldSize: 4 * 1024,
  },
});

/**
 * Turns multer's own errors into the envelope, and nothing else into a 500.
 *
 * Registered as the layer immediately after `upload.single`, because a size
 * rejection arrives as a thrown `MulterError` rather than as a status this
 * handler could set.
 */
const uploadFile = [
  upload.single('file'),
  ((err: unknown, _req: Request, _res: never, next: (err?: unknown) => void) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(
          new ApiError(
            413,
            'UPLOAD_TOO_LARGE',
            `That file is too large. The limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`,
          ),
        );
        return;
      }

      // Every other limit this route sets — too many parts, too many fields, a
      // field value over its cap, a second file. Left to fall through these
      // became 500s, which reads as a fault in the service rather than as a
      // request it declined to buffer.
      next(new ApiError(413, 'UPLOAD_TOO_LARGE', 'That upload request is too large.'));
      return;
    }
    next(err);
  }) as never,
];

const textSourceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  content: z.string().trim().min(1).max(200_000),
  description: z.string().trim().max(500).optional(),
});

const linkSourceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z
    .string()
    .trim()
    .max(2_000)
    // Not a bare URL check: `file:` and `data:` parse as URLs, and a fetcher
    // asked to read one reads whatever the platform's own filesystem holds.
    .refine((value) => /^https?:\/\//i.test(value), {
      message: 'url must start with http:// or https://',
    }),
  description: z.string().trim().max(500).optional(),
});

/** Same lookup the agent routes use — ownership is part of finding the row. */
async function agentInWorkspace(req: Request): Promise<Agent> {
  const agent = await prisma.agent.findFirst({
    where: { id: req.params.agentId, workspaceId: workspaceOf(req).id },
  });

  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');

  return agent;
}

/**
 * Maps a freshly created document to the workspace, then links it to the agent.
 *
 * Mapping comes first on purpose. If the link fails, the document is mapped
 * but unattached — and reachable: it appears in this workspace's document
 * library (`GET /:workspaceId/documents`), which lists what the workspace owns
 * rather than what is attached, so it can still be deleted. Linking first and
 * failing to map would instead leave a document attached to an agent that no
 * workspace could ever prove it owned, and so could never remove.
 */
async function mapAndLink(
  upstream: UpstreamRecord,
  agent: Agent,
  workspaceId: string,
): Promise<void> {
  const documentId = readString(upstream, ['id', 'document_id', 'documentId']);
  if (!documentId) {
    throw new ApiError(502, 'UPSTREAM_ERROR', 'The voice platform did not return a document.');
  }

  await claimCreated('DOCUMENT', documentId, workspaceId, readString(upstream, ['name']));
  await linkDocuments(agent.externalId, [documentId]);
}

/**
 * Adds a file.
 *
 * **Middleware order is the security control here.** `requireMembership` runs
 * before `upload.single`, so a stranger's 25MB body is never buffered into
 * this process's heap — reversed, an authorisation check becomes a
 * memory-exhaustion vector. The agent lookup then runs before the first
 * upstream call, so a probe for another workspace's agent never spends one.
 */
// The path ends in a literal ':upload'. The colon is escaped because the
// router would otherwise read `:upload` as a route parameter — and one that
// matches `:text` and `:link` too, silently swallowing both.
agentDocumentRoutes.post(
  '/:workspaceId/agents/:agentId/documents\\:upload',
  requireAuth,
  requireMembership(),
  writeLimiter,
  ...uploadFile,
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Attach a file under the field name "file".');
    }

    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new ApiError(
        415,
        'UNSUPPORTED_FILE_TYPE',
        'That file type cannot be used as a knowledge source. ' +
          'PDF, Word, Excel, text, Markdown and images are accepted.',
      );
    }

    const agent = await agentInWorkspace(req);
    const workspaceId = workspaceOf(req).id;

    const ticket = await createDocumentUpload({
      name: file.originalname.slice(0, 100),
      file_size: file.size,
      mime_type: file.mimetype,
    });

    const documentId = ticket.document_id;
    const uploadUrl = ticket.upload_url;
    if (!documentId || !uploadUrl) {
      throw new ApiError(502, 'UPSTREAM_ERROR', 'The voice platform did not accept the upload.');
    }

    await putToPresignedUrl(uploadUrl, file.buffer, file.mimetype);
    const confirmed = await confirmDocument(documentId);

    // `...confirmed` first, so the id the bytes were actually uploaded under
    // wins. Spread last, an `id` in the confirm response would override it and
    // the mapping would record one document while the file lived under another.
    await mapAndLink(
      { name: file.originalname, ...confirmed, id: documentId },
      agent,
      workspaceId,
    );

    res.status(201).json({ success: true, data: { added: true, name: file.originalname } });
  }),
);

agentDocumentRoutes.post(
  '/:workspaceId/agents/:agentId/documents\\:text',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(textSourceSchema, req.body);
    const agent = await agentInWorkspace(req);

    const created = await createParagraphDocument(body);
    await mapAndLink(created, agent, workspaceOf(req).id);

    res.status(201).json({ success: true, data: { added: true, name: body.name } });
  }),
);

agentDocumentRoutes.post(
  '/:workspaceId/agents/:agentId/documents\\:link',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(linkSourceSchema, req.body);
    const agent = await agentInWorkspace(req);

    const created = await createWebLinkDocument(body);
    await mapAndLink(created, agent, workspaceOf(req).id);

    res.status(201).json({ success: true, data: { added: true, name: body.name } });
  }),
);

/**
 * Lists the agent's sources, each with its indexing state.
 *
 * Two upstream calls merged rather than one, because the document list says
 * what is attached and the sync-status list says whether the agent can
 * actually read it — and a source that failed to index is worse than a missing
 * one, since the reader believes the agent knows something it does not.
 *
 * Sync status is best-effort: if that call fails the list is still worth
 * showing, and each row reports its state as unknown rather than as synced.
 *
 * Every attached document is listed, including one a workspace does not own —
 * hiding it would make the knowledge base look smaller than it is. Ownership
 * decides what may be *acted on*, and travels with each row as `removable`.
 */
agentDocumentRoutes.get(
  '/:workspaceId/agents/:agentId/documents',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const agent = await agentInWorkspace(req);

    const { documents } = await getAgentDocuments(agent.externalId);
    const rows = Array.isArray(documents) ? documents : [];

    let syncRows: UpstreamRecord[] = [];
    try {
      const status = await getDocumentSyncStatus(agent.externalId);
      syncRows = Array.isArray(status.documents) ? status.documents : [];
    } catch (err) {
      console.error(`Could not read sync status for agent ${agent.externalId}:`, err);
    }

    const owned = await prisma.workspaceResource.findMany({
      where: {
        kind: 'DOCUMENT',
        workspaceId: workspaceOf(req).id,
        externalId: {
          in: rows
            .map((row) => readString(row, ['id', 'document_id', 'documentId']))
            .filter((id): id is string => !!id),
        },
      },
      select: { externalId: true },
    });

    res.json({
      success: true,
      data: serializeAgentDocuments(rows, syncRows, new Set(owned.map((row) => row.externalId))),
    });
  }),
);

/**
 * Removes a source from the agent — unlink, then delete.
 *
 * Only a document this workspace created may be removed. One attached by staff
 * outside the platform has no mapping and is refused with the same 404 a
 * foreign document gets: a workspace may not detach something it did not
 * attach, and may not learn which is which.
 *
 * **The document is deleted, not merely unlinked.** A source here is created
 * by, and linked to, exactly one agent — there is no attach-an-existing-
 * document flow — so unlinking is the end of its life. Leaving it behind grows
 * the partner account without bound with rows no workspace can see, reclaim,
 * or delete, and the customer keeps paying to store them.
 *
 * Unlink first, delete second. The unlink is what the caller asked for; if the
 * delete then fails, the mapping is kept so the leftover stays attributable —
 * and, because the library listing is keyed on the mapping rather than on what
 * is attached, still reachable and still deletable. Saying so is the point: a
 * partial failure reported as `{ removed: true }` told the reader their file
 * was gone when it was not, and gave them nothing to act on.
 */
/**
 * Every document this workspace owns, attached or not.
 *
 * Keyed on the mapping rather than on what upstream reports as linked, which
 * is what makes it a recovery path: a document whose link failed, or whose
 * delete failed after it was unlinked, is still owned and so still appears
 * here. Without this listing those two states were unreachable — invisible to
 * every route, undeletable, and billed.
 *
 * It holds no content, only what the mapping already records: the platform
 * still owns the file, and there is no second copy of a customer's document
 * here to keep correct.
 */
agentDocumentRoutes.get(
  '/:workspaceId/documents',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const rows = await prisma.workspaceResource.findMany({
      where: { kind: 'DOCUMENT', workspaceId: workspaceOf(req).id },
      orderBy: { createdAt: 'desc' },
      select: { externalId: true, name: true, createdAt: true },
    });

    res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.externalId,
        name: row.name,
        added_at: row.createdAt,
      })),
    });
  }),
);

/**
 * Deletes a document this workspace owns, whatever it is or is not attached to.
 *
 * The agent-scoped delete above is the ordinary route; this one exists for the
 * rows that route can leave behind.
 */
agentDocumentRoutes.delete(
  '/:workspaceId/documents/:documentId',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { documentId } = req.params;
    await resourceInWorkspace('DOCUMENT', documentId, workspaceOf(req).id);

    await deleteDocument(documentId);
    await unmapResource('DOCUMENT', documentId);

    res.json({ success: true, data: { deleted: true } });
  }),
);

agentDocumentRoutes.delete(
  '/:workspaceId/agents/:agentId/documents/:documentId',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const agent = await agentInWorkspace(req);
    const { documentId } = req.params;
    await resourceInWorkspace('DOCUMENT', documentId, workspaceOf(req).id);

    await unlinkDocument(agent.externalId, documentId);

    try {
      await deleteDocument(documentId);
    } catch (err) {
      console.error(`Unlinked document ${documentId} but could not delete it:`, err);
      res.json({
        success: true,
        data: {
          removed: true,
          deleted: false,
          detail:
            'It was removed from the agent, but the voice platform could not delete the file. ' +
            'It remains in this workspace\'s document library, where it can be deleted again.',
        },
      });
      return;
    }

    // Only once the file is really gone. Unmapping on a failed delete would
    // strand it: still stored, still billed, and no longer nameable by anyone.
    await unmapResource('DOCUMENT', documentId);

    res.json({ success: true, data: { removed: true, deleted: true } });
  }),
);

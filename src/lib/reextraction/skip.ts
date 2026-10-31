/**
 * A conversation this run will not re-judge, and why.
 *
 * Separate from a failure on purpose. A run walks a thousand conversations
 * and some of them cannot be re-extracted at all — a dump the platform no
 * longer has, a call with no transcript, a reply that is not JSON. None of
 * those is a bug in the run, and none of them may stop it: the contact is
 * left exactly as it is, the reason goes in the report beside its row, and
 * the next conversation is fetched.
 *
 * The reason is carried as a field rather than only in the message because
 * the report groups by it, and grouping by a sentence is grouping by
 * whichever wording somebody last edited.
 */
export class ReextractionSkip extends Error {
  readonly reason: string;

  constructor(reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ReextractionSkip';
    this.reason = reason;
  }
}

/**
 * A run that will not start at all.
 *
 * The opposite of a skip in every way that matters: a skip is one row of a
 * thousand and the run walks on, this stops before the first conversation is
 * fetched. It is thrown for the conditions under which the run itself would be
 * unsafe or meaningless — a campaign the dispatcher may still be dialling, a
 * campaign id that names nothing — where continuing would rewrite a queue
 * being read at the same time by something that dials telephones.
 */
export class ReextractionRefused extends Error {
  readonly reason: string;

  constructor(reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ReextractionRefused';
    this.reason = reason;
  }
}

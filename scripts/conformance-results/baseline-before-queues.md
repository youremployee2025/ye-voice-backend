# Conformance run results

## Scenarios

| Scenario | Rows | Runs | Failed runs | Dials | Wall time |
|---|---|---|---|---|---|
| basic-drain | D1 D2 L6 | 3 | 0 | 24 | 0.6s |
| concurrency | D6 D7 D8 D9 | 3 | 0 | 30 | 1.0s |
| retry-matrix | R1 R2 R3 R4 | 3 | 0 | 45 | 0.8s |
| retry-budget-lowering | R5 CB2 | 3 | 0 | 15 | 0.5s |
| callbacks | CB1 CB2 CB3 CB4 CB5 CB6 | 3 | 0 | 39 | 1.1s |
| dial-window | W1 W2 | 3 | 0 | 6 | 0.2s |
| lifecycle | L1 L2 L3 L4 L5 L7 L8 CB4 D10 | 3 | 0 | 27 | 0.7s |
| exactly-once | X1 X2 | 10 | 0 | 120 | 1.9s |
| transient-faults | X3 X4 X5 | 10 | 0 | 30 | 1.7s |
| stuck-cleanup | S1 S2 S3 S4 | 3 | 0 | 12 | 0.4s |
| billing | B1 B2 B3 B4 | 3 | 0 | 12 | 0.3s |
| rotation | N1 N2 | 3 | 0 | 27 | 0.7s |
| lane-budgets | D3 D4 | 3 | 0 | 30 | 0.5s |

## Verdicts

| Row | Verdict |
|---|---|
| D1 | MATCHES |
| D2 | MATCHES |
| D3 | MATCHES |
| D4 | MATCHES |
| D5 | DIVERGES-DELIBERATE (not machine-graded: configuration inspection) |
| D6 | DIVERGES-DELIBERATE |
| D7 | MATCHES |
| D8 | MATCHES |
| D9 | MATCHES |
| D10 | DIVERGES-DELIBERATE |
| X1 | MATCHES |
| X2 | MATCHES |
| X3 | DIVERGES-DELIBERATE |
| X4 | DIVERGES-DELIBERATE |
| X5 | MATCHES |
| R1 | MATCHES |
| R2 | MATCHES |
| R3 | MATCHES |
| R4 | MATCHES |
| R5 | MATCHES |
| CB1 | MATCHES |
| CB2 | MATCHES |
| CB3 | MATCHES |
| CB4 | MATCHES |
| CB5 | MATCHES |
| CB6 | DIVERGES-DELIBERATE |
| W1 | DIVERGES-DELIBERATE |
| W2 | MATCHES |
| L1 | MATCHES |
| L2 | MATCHES |
| L3 | MATCHES |
| L4 | MATCHES |
| L5 | MATCHES |
| L6 | MATCHES |
| L7 | MATCHES |
| L8 | MATCHES |
| S1 | DIVERGES-DELIBERATE |
| S2 | MATCHES |
| S3 | DIVERGES-DELIBERATE |
| S4 | MATCHES |
| B1 | MATCHES |
| B2 | DIVERGES-DELIBERATE |
| B3 | MATCHES |
| B4 | DIVERGES-DELIBERATE |
| N1 | MATCHES |
| N2 | MATCHES |

# T6 deterministic lender fit

Approved purpose: brokers compare reproducible lender fit against configured criteria, understand exclusions and missing data, and make the final selection. No client rate sheets or lender criteria are available yet. Never fabricate lender terms, approval odds, or eligibility decisions.

Reuse the current deterministic scoring policy, criterion publishing/versioning, score snapshots, workspace/deal permissions, and submissions selection. Add nullable sourceAsOf and validUntil (ISO calendar dates) to each existing criterion alongside sourceText. Missing provenance stays explicit; configured expiry is evaluated against an explicit as-of clock. No arbitrary freshness interval is invented. Add dates to criterion fingerprints so changes increment criteriaVersion. Existing rows retain null dates. Admins edit these fields in CriteriaPanel; date errors are rejected server-side.

Scoring distinguishes matched configured criteria, exclusion by a failed configured rule, needs_review for unspecified/no rules or missing inputs/provenance, inactive lenders, and explicitly expired criteria. The numeric score remains internal fit evidence, never approval probability. No rules cannot yield a match. Unspecified rules cannot silently pass. Inactive lenders are included with an explanation. Automatic selection ignores needs_review and expired entries. Broker final selection uses the existing submissions workflow; fit UI links there and never sends or selects automatically.

Add a versioned read-only lender-fit service/HTTP API for estimates. It reads authorized existing snapshots and current criteria, never computes or persists scoring. It returns snapshot versions/time, global stale reasons, stable ordered lender IDs/names, status, configured rules/provenance/missing data, numeric fit evidence only when current. A stale snapshot cannot be used as a current match; changes to active state and date expiry invalidate actionable fits. No funding amount, factor rate, term or approval probability is inferred.

Alternatives considered: rebuild scoring (duplicates proven policy), AI scoring (unnecessary and nonreproducible), extend existing scoring plus separate read projection (chosen). Per-rule provenance is chosen over a set-wide synthetic policy date to preserve distinct source facts.

Ownership: funders criterion contracts/service/repository/UI; underwriting scoring/fit contracts/service/score UI; additive columns in db/schema.ts and reserved forward migration/journal coordinated with parent. Estimates consumes the fit API, owns estimate calculations. No other feature contract required.

Checks: deterministic ties/replay; no and unspecified criteria; missing merchant/provenance data; expired/future dates; inactive changes; empty snapshot; tenant/role/API scope negatives; publish fingerprint/date roundtrip; score and criteria regressions; typecheck/lint; coordinated build/aggregate. Local disposable Postgres only. Hosted migration/browser acceptance and real lender data remain review gates.

Spec self-review: no placeholders; date expiry semantics validUntil is inclusive UTC; sourceAsOf is a source fact, never publishedAt. Missing dates do not imply invented freshness. Broad configured hard-rule evaluation remains unchanged; fit status is decision support.

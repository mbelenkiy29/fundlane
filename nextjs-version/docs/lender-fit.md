# Lender fit contract v1

`GET /api/mca/underwriting/lender-fit/[dealId]` and `getLenderFit(actor, dealId)` are authorized, no-store reads of existing scoring snapshots plus current workspace criteria. No read computes scoring or persists data. `POST /api/mca/underwriting/scores/[dealId]` remains the explicit scoring operation.

Response `contractVersion: 1`, `brokerSelectionRequired: true`, `asOf` (UTC evaluation clock), `snapshotId`/`scoredAt` (nullable), `policyVersion`, `underwritingVersion`, `stale`, `staleReasons`, `disclaimer`, `lenders[]`.

Each lender has `funderId`, `name`, `active`, `criteriaVersion`, `status`, `score`/`rank` (nullable), `reasons[{ruleId,result,detail}]`, `criteria:{rules[]}`, `missingData[]`. Rules preserve configured operator, units/value, sourceText, optional sourceAsOf and validUntil. Criterion dates are ISO calendar dates. `validUntil` includes that UTC day. No maximum age or expiry date is invented. Missing source or sourceAsOf requires review. No rules and unspecified values cannot confirm a match.

Statuses: `matched` (configured rules matched, not lender approval), `excluded` (configured hard rule failed), `needs_review` (unknown evidence or stale/legacy snapshot), `inactive`, `stale_criteria` (explicit expiry passed), `unscored`. Only current matched entries have numeric rank/score in this read API. Scores are fit evidence out of 100, never approval probability. Inactive lenders are retained and explained. Ties use funder ID, independent of request order. Broker selects through the existing deal submissions tab, with its preview/approval gates.

Estimates may display this evidence, snapshot/source versions and missing inputs. This API provides no estimated funding amount, factor rate, term, payment or commission. Broker-entered scenario assumptions and actual lender offers must retain their distinct sources. Client lender criteria and rate sheets are still unavailable; do not seed realistic-looking provider data.

Rollout requires reviewed forward migration for nullable criterion dates, then application deployment. Existing rows retain missing dates until company admins supply verified source facts. No historical dates are inferred from publication time. No hosted migrations or live provider actions are performed in T6. Hosted tenant/browser acceptance and real source collection remain human review gates.

# Sandbox money-flow QA script

Use this script in a **nonproduction** workspace (or a disposable preview) to walk the core money flow without contacting a real merchant, lender, or mailbox. The sandbox funder is workspace-scoped, labeled `[SANDBOX]`, and never sends email, SMS, or external HTTP.

Related issue: GitHub #68.

## What this is not

- Not a live lender, bank, or underwriting decision.
- Not a way to test real provider adapters, senders, or webhooks. Those remain #40 / #41 / #49.
- Not a production seed. Enable it only in the workspace you are demonstrating or testing.

## Prerequisites

1. Sign in as a workspace **admin**.
2. Open **Funders**.
3. In the amber **Sandbox demo funder** card, turn the sandbox **on**. Confirm the directory row is named `[SANDBOX] Fundlane Demo Funder — not a real lender` and shows a **SANDBOX** badge.
4. Download the synthetic sample statements from that card (QA Test Pizza LLC plus Sandbox Demo Retail LLC, last three closed months). Each PDF is stamped `SYNTHETIC SAMPLE — NOT A REAL BANK STATEMENT`.

## Script

Create a deal named **QA Test Pizza LLC** (or reuse the demo deal). Keep the name free of `SANDBOX-DECLINE` unless you are running the decline path.

### 1. Upload

1. Open the deal → **Documents**.
2. Upload the three **QA Test Pizza LLC** sample statement PDFs as category **Bank statement**.
3. Completeness still requires an application, driver license, and voided check. For sandbox QA, upload any clearly fake PDF (you may reuse a sample statement file) into those three categories. Do not use a real person's ID or a live merchant file.

Expected: documents reach a ready/clean state. Sample statements remain labeled synthetic in the filename.

### 2. AI underwriting

1. Open the deal → **Underwriting**.
2. Run statement extraction / completeness, then score the deal.

Expected: completeness can become ready once the required categories and lookback months are present. Scoring may use fixture or live extraction depending on the environment. The sandbox funder has **no hard disqualify rules**, so a typical pizza-merchant demo should stay eligible for matching.

### 3. Matching

1. Stay on **Underwriting** (or the funder match list) and confirm `[SANDBOX] Fundlane Demo Funder — not a real lender` is listed for this workspace.
2. Confirm no other workspace's funders appear.

Expected: the sandbox destination is selectable and cannot be confused with a live lender.

### 4. Submission

1. Open **Submissions** on the deal.
2. Select only the sandbox funder. Preflight should **not** require a verified submission email sender (the route is a local API destination, not email).
3. Submit.

Expected: the job moves to **sent** without any outbound email, SMS, or HTTP. The attempt reference looks like `sandbox:offer:…`. The job display name is the full `[SANDBOX]` legal name.

### 5. Reply-to-offer

1. Open the deal → **Offers**.
2. A synthetic offer should already exist from the sandbox delivery (manual source, product `[SANDBOX] Synthetic MCA — not a real funding commitment`, stipulation `SYNTHETIC SANDBOX OFFER`).
3. Select that offer revision.

Expected: deal status can move to **offer**. Terms are complete enough to continue closing. This is not a real commitment.

### 6. Contract

1. Open the deal **Offers** / closing panel.
2. Accept the selected sandbox offer for closing.
3. Record a contract signature using synthetic signer names only.

Expected: a closing workflow exists on this deal only. No document is sent to a real signer mailbox unless you separately trigger a live sender (do not do that in this script).

### 7. Funding

1. Confirm funding on the selected sandbox offer using the deal funding action.
2. Use a synthetic funded date and the sandbox offer amounts.

Expected: the deal / advance shows **funded**. Accounting rows stay in this workspace. The offer source is `manual`, so this is a live-path funding of a synthetic offer—not an admin-only historical backfill.

### 8. Renewal

1. Open **Renewals**.
2. Run renewal eligibility for the workspace (or wait for the funded advance to appear).
3. Confirm the sandbox-funded advance can be followed as a renewal candidate.

Expected: eligibility is computed from the synthetic funded advance in this workspace only.

## Decline path (optional)

1. Create or rename a deal so the legal name contains `SANDBOX-DECLINE`.
2. Submit that deal to the sandbox funder.

Expected: the job is **declined** with a `[SANDBOX] Synthetic decline` reason. No offer is created. Remove the marker and submit again (or use a new deal) to get the sample offer.

## Isolation checks

- A second workspace that has not enabled the sandbox must not list or receive the first workspace's sandbox funder.
- Enabling the sandbox in the second workspace creates a **separate** funder row.
- Turning the sandbox off archives the workspace's sandbox funder (inactive). It cannot be selected for new submissions until it is enabled again.

## Sales demo notes

The same enable + sample-statement setup is enough for a walkthrough. Stay on synthetic merchants and the `[SANDBOX]` funder. Do not attach production senders, live lender credentials, or real bank files.

# SEN-32 and SEN-35 acceptance evidence

Run the focused domain checks from `nextjs-version`:

```sh
mca_test_dir=$(mktemp -d) && ./node_modules/.bin/tsc --outDir "$mca_test_dir" --rootDir src/lib/mca --module commonjs --moduleResolution node --target ES2022 --esModuleInterop --skipLibCheck src/lib/mca/deals/acceptance.test.ts && node --test "$mca_test_dir/deals/acceptance.test.js"
```

## SEN-32 scenarios

| Scenario | Expected output |
| --- | --- |
| Save `Harbor Coffee LLC` with no entity, address, owner, revenue, purpose, or amount | HTTP 201, stable `MCA-####` identity, `draftState: partial`, and explicit `missingRequiredFields`; the same idempotency key returns the same record with `x-idempotent-replay: true`. |
| Save an EIN with 3 digits, FICO 900, NAICS 2 digits, and an owner at 110% | HTTP 422 with field-specific messages for every invalid field. The draft form and idempotency key remain in the browser. |
| Store owner DOB, identity digits, email, and phone | SQLite contains AES-256-GCM ciphertext. List/search responses omit owner values. Authorized detail responses return masks; activity and audit metadata contain field names only. |
| Assign two originators and two closers | Every target must be an active membership in the same workspace. Each kind has exactly one primary marker. A rep can assign only themself; a manager can assign themself or an actively managed rep. |
| Manager views a managed rep's deal | A managed-originator assignment is visible. A deal where the managed rep is only a closer is not visible. Direct detail requests return the same not-found response as missing records. |
| Browser A and Browser B both open version 3; A saves, then B saves | A receives version 4. B receives HTTP 409 with the current masked record, attempted field names, and actions to reload or retry against version 4. B's unsaved form stays intact. |
| Import/application scan writes fields | `fieldSources` records the source, actor, capture time, and correlation ID per changed field. Sensitive values never enter history summaries. |

## SEN-35 scenarios

| Scenario | Expected output |
| --- | --- |
| Filter by search, status, assignee, inclusive created dates, and funder | Filters persist in the URL. Table rows and Kanban cards use one server-filtered collection; the sum of Kanban status counts equals `total`. Dates use UTC start-of-day through the exclusive start of the following day. |
| Move Lead directly to Funded | HTTP 422 includes the allowed next statuses. |
| Move through an allowed status path | The deal version increments and an activity/audit entry records actor, source, old status, new status, correlation ID, and timestamp. Closed/default/missed-payment states have defined recovery paths. |
| Move Contract to Funded | Deal status changes to Funded and the response explicitly reports `advanceCreated: false` and `commissionCreated: false`. No advance or commission table is touched; those belong to dedicated workflows. |
| Compare deal/submission/offer states | Deal lifecycle is stored on `deals`; funder submission state is stored on `deal_submissions`; offer state is stored on `deal_offers`. A deal transition does not synthesize either related record. |
| Use a missing or wrong-scope API key on list/detail/update/notes/transition | The server rejects it before any workspace query or mutation. Every query includes `workspace_id`, and visible list counts are calculated after assignment visibility is applied. |

The lifecycle is version 1 and includes Lead, New application, Missing documents, Ready to submit, Submitted, Resubmitting, Offer, Repricing, Contract, Funded, Renewed, Closed, Default, and Missed payments. These names follow the ticket's cited public workflow terms; the source does not publish MCA Pilot's internal transition graph, so the allowed and recovery edges are an MCA product definition.

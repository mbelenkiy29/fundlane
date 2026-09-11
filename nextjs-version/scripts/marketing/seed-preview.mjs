// Called only by the disposable Clerk preview harness. No application database.
import { randomUUID } from "node:crypto"

export async function seedMarketingPreview(
  db,
  { workspaceId, memberId, userId }
) {
  if (!db.databaseName?.startsWith("fundlane_test_"))
    throw new Error("Marketing captures require a disposable database.")
  const now = new Date().toISOString()
  await db.query(
    "UPDATE workspaces SET name='Fundlane demo brokerage',seat_limit=10 WHERE id=$1",
    [workspaceId]
  )
  await db.query("UPDATE users SET name='Alex Morgan' WHERE id=$1", [userId])
  await db.query(
    "INSERT INTO mca_renewal_policies (workspace_id,paid_in_threshold_basis_points,minimum_days_since_funding,version,updated_at) VALUES ($1,5000,60,1,$2)",
    [workspaceId, now]
  )
  for (const [index, [name, status, amount, revenue]] of [
    ["Harbor Coffee", "new_application", 75000, 126000],
    ["Cedar Auto Repair", "ready_to_submit", 120000, 210000],
    ["Summit Dental", "submitted", 95000, 182000],
    ["Northside Kitchen", "offer", 60000, 98000],
    ["Oak & Elm Retail", "contract", 85000, 147000],
    ["Bluebird Logistics", "funded", 150000, 285000],
    ["Brooklyn Bakery", "missing_documents", 45000, 82000],
    ["Evergreen Landscaping", "renewed", 110000, 198000],
  ].entries()) {
    const id = randomUUID()
    await db.query(
      `INSERT INTO deals (id,workspace_id,display_id,legal_name,entity_type,address_json,contact_name,start_date,industry,monthly_revenue,fico_score,funding_purpose,requested_amount,status,draft_state,missing_required_json,field_sources_json,created_at,updated_at)
      VALUES ($1,$2,$3,$4,'llc',$5,'Jamie Taylor','2020-05-01','Services',$6,710,'Working capital',$7,$8,'partial',$9,'{}',$10,$10)`,
      [
        id,
        workspaceId,
        `MCA-${2100 + index}`,
        name,
        JSON.stringify({
          line1: "100 Example Street",
          city: "New York",
          state: "NY",
          postalCode: "10001",
          country: "US",
        }),
        revenue,
        amount,
        status,
        JSON.stringify(["contactEmail", "contactPhone", "owners"]),
        now,
      ]
    )
    await db.query(
      "INSERT INTO deal_assignments (id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at) VALUES ($1,$2,$3,$4,'originator',1,$5)",
      [randomUUID(), workspaceId, id, memberId, now]
    )
    if (status === "funded" || status === "renewed") {
      const offerId = randomUUID(),
        revisionId = randomUUID(),
        eventId = randomUUID(),
        advanceId = randomUUID()
      const fundedAt = new Date(Date.now() - 120 * 86400000).toISOString()
      await db.query(
        "INSERT INTO mca_offers (id,workspace_id,deal_id,funder_name,source,current_revision_id,created_at,updated_at) VALUES ($1,$2,$3,'Example Capital','historical',$4,$5,$5)",
        [offerId, workspaceId, id, revisionId, now]
      )
      await db.query(
        "INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,factor_rate_millionths,payment_frequency,effective_at,created_at) VALUES ($1,$2,$3,1,'funded',$4,1300000,'daily',$5,$5)",
        [revisionId, workspaceId, offerId, amount * 100, fundedAt]
      )
      await db.query(
        "INSERT INTO mca_funding_events (id,workspace_id,deal_id,offer_id,offer_revision_id,advance_id,idempotency_key,funded_at,amount_cents,source,created_at) VALUES ($1,$2,$3,$4,$5,$6,$1,$7,$8,'historical',$9)",
        [
          eventId,
          workspaceId,
          id,
          offerId,
          revisionId,
          advanceId,
          fundedAt,
          amount * 100,
          now,
        ]
      )
      await db.query(
        `INSERT INTO mca_advances (id,workspace_id,deal_id,funding_event_id,offer_id,offer_revision_id,source,status,principal_cents,payback_cents,periodic_payment_cents,payment_count,payment_frequency,calendar_convention,commission_cents,fee_cents,funded_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'historical','active',$7,$8,$9,100,'daily','business_days',$10,0,$11,$12,$12)`,
        [
          advanceId,
          workspaceId,
          id,
          eventId,
          offerId,
          revisionId,
          amount * 100,
          amount * 130,
          Math.round(amount * 1.3),
          amount * 10,
          fundedAt,
          now,
        ]
      )
      await db.query(
        "INSERT INTO mca_renewal_actions (id,workspace_id,source_advance_id,policy_version,eligible_at,state,message_subject,message_body,idempotency_key,created_at,updated_at) VALUES ($1,$2,$3,1,$4,'eligible',$5,$6,$1,$4,$4)",
        [
          randomUUID(),
          workspaceId,
          advanceId,
          now,
          `Next steps for ${name}`,
          `Hi Jamie, let’s review your updated statements and discuss the next funding opportunity for ${name}.`,
        ]
      )
    }
  }
}

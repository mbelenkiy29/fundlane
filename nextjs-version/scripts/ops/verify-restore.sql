BEGIN READ ONLY;

SELECT 'workspaces' AS item, count(*) AS total FROM workspaces
UNION ALL SELECT 'deals', count(*) FROM deals
UNION ALL SELECT 'documents', count(*) FROM mca_documents
UNION ALL SELECT 'memberships', count(*) FROM memberships
UNION ALL SELECT 'background_jobs', count(*) FROM mca_background_jobs
UNION ALL SELECT 'billing_invoices', count(*) FROM company_billing_invoices
UNION ALL SELECT 'billing_payments', count(*) FROM company_billing_payments
UNION ALL SELECT 'credit_accounts', count(*) FROM mca_credit_accounts
UNION ALL SELECT 'credit_ledger', count(*) FROM mca_credit_ledger;

WITH restore_orphans AS (
SELECT 'document_deal_or_workspace' AS item, count(*) AS total FROM mca_documents d
  LEFT JOIN deals deal ON deal.id = d.deal_id AND deal.workspace_id = d.workspace_id
  LEFT JOIN workspaces w ON w.id = d.workspace_id
  WHERE deal.id IS NULL OR w.id IS NULL
UNION ALL SELECT 'membership_user_or_workspace', count(*) FROM memberships m
  LEFT JOIN users u ON u.id = m.user_id
  LEFT JOIN workspaces w ON w.id = m.workspace_id
  WHERE u.id IS NULL OR w.id IS NULL
UNION ALL SELECT 'payment_invoice_or_workspace', count(*) FROM company_billing_payments p
  LEFT JOIN company_billing_invoices i ON i.stripe_invoice_id = p.stripe_invoice_id AND i.workspace_id = p.workspace_id
  LEFT JOIN workspaces w ON w.id = p.workspace_id
  WHERE i.stripe_invoice_id IS NULL OR w.id IS NULL
UNION ALL SELECT 'credit_ledger_account', count(*) FROM mca_credit_ledger l
  LEFT JOIN mca_credit_accounts a ON a.id = l.account_id
  WHERE a.id IS NULL
)
SELECT item, total FROM restore_orphans;

SELECT 1 / CASE WHEN (
  (SELECT count(*) FROM mca_documents d LEFT JOIN deals deal ON deal.id=d.deal_id AND deal.workspace_id=d.workspace_id LEFT JOIN workspaces w ON w.id=d.workspace_id WHERE deal.id IS NULL OR w.id IS NULL)
  + (SELECT count(*) FROM memberships m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN workspaces w ON w.id=m.workspace_id WHERE u.id IS NULL OR w.id IS NULL)
  + (SELECT count(*) FROM company_billing_payments p LEFT JOIN company_billing_invoices i ON i.stripe_invoice_id=p.stripe_invoice_id AND i.workspace_id=p.workspace_id LEFT JOIN workspaces w ON w.id=p.workspace_id WHERE i.stripe_invoice_id IS NULL OR w.id IS NULL)
  + (SELECT count(*) FROM mca_credit_ledger l LEFT JOIN mca_credit_accounts a ON a.id=l.account_id WHERE a.id IS NULL)
) = 0 THEN 1 ELSE 0 END AS integrity_ok;
COMMIT;

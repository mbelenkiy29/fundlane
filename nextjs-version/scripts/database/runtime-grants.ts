/** Least-privilege exceptions survive both initial migration and release securing. */
export function runtimeTablePrivileges(table:string):string {
  if(table==='platform_admin_grants')return 'SELECT'
  if(['roadmap_item_audit','platform_admin_audit','mca_notification_receipts','sms_credit_ledger'].includes(table))return 'SELECT, INSERT'
  if(['platform_step_ups','sms_credit_accounts','sms_credit_reservations'].includes(table))return 'SELECT, INSERT, UPDATE'
  if(['voice_config','voice_dial_intents','voice_calls'].includes(table))return 'SELECT, INSERT, UPDATE'
  return 'SELECT, INSERT, UPDATE, DELETE'
}

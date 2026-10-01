/** Least-privilege exceptions survive both initial migration and release securing. */
export function runtimeTablePrivileges(table:string):string {
  if(table==='platform_admin_grants')return 'SELECT'
  if(['roadmap_item_audit','platform_admin_audit','mca_notification_receipts','sms_credit_ledger','mca_onboarding_service_email_receipts'].includes(table))return 'SELECT, INSERT'
  if(['mca_enrollment_billing_evidence','mca_enrollment_trial_reservations','mca_enrollments','mca_enrollment_checkout_requests','mca_enrollment_challenges','mca_onboarding_service_emails','mca_service_email_suppressions','company_basic_profiles','mca_sender_test_runs'].includes(table))return 'SELECT, INSERT, UPDATE'
  if(['platform_step_ups','sms_credit_accounts','sms_credit_reservations'].includes(table))return 'SELECT, INSERT, UPDATE'
  if(['voice_config','voice_dial_intents','voice_calls'].includes(table))return 'SELECT, INSERT, UPDATE'
  return 'SELECT, INSERT, UPDATE, DELETE'
}

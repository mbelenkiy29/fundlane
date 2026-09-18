-- Run only after both deployments and a successful manual invocation.
-- Vault must already contain fundlane_monitor_token. Preserve all other schedules.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='fundlane_monitor_token') THEN
    RAISE EXCEPTION 'Missing monitor Vault secret';
  END IF;
END $$;
SELECT cron.schedule('fundlane-platform-monitor','* * * * *', $job$
  SELECT net.http_post(
    url := 'https://drubsfvhlggmtyiigwxy.supabase.co/functions/v1/platform-monitor',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='fundlane_monitor_token')),
    body := '{}'::jsonb, timeout_milliseconds := 50000
  );
$job$);

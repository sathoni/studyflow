-- 0012 · The notify function (service_role) reads and writes the two reminder
-- tables, like the other tables: select, insert, update, delete, nothing more.
revoke all on public.push_subscriptions, public.notification_log from service_role;
grant select, insert, update, delete on public.push_subscriptions, public.notification_log to service_role;

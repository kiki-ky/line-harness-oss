import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { LineClient } from '@line-crm/line-sdk';
import { getLineAccounts } from '@line-crm/db';
import { processStepDeliveries } from './services/step-delivery.js';
import { processScheduledBroadcasts } from './services/broadcast.js';
import { processReminderDeliveries } from './services/reminder-delivery.js';
import { checkAccountHealth } from './services/ban-monitor.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { webhook } from './routes/webhook.js';
import { friends } from './routes/friends.js';
import { tags } from './routes/tags.js';
import { scenarios } from './routes/scenarios.js';
import { broadcasts } from './routes/broadcasts.js';
import { users } from './routes/users.js';
import { lineAccounts } from './routes/line-accounts.js';
import { conversions } from './routes/conversions.js';
import { affiliates } from './routes/affiliates.js';
import { openapi } from './routes/openapi.js';
import { liffRoutes } from './routes/liff.js';
// Round 3 ルート
import { webhooks } from './routes/webhooks.js';
import { calendar } from './routes/calendar.js';
import { reminders } from './routes/reminders.js';
import { scoring } from './routes/scoring.js';
import { templates } from './routes/templates.js';
import { chats } from './routes/chats.js';
import { notifications } from './routes/notifications.js';
import { stripe } from './routes/stripe.js';
import { health } from './routes/health.js';
import { automations } from './routes/automations.js';
import { richMenus } from './routes/rich-menus.js';
import { trackedLinks } from './routes/tracked-links.js';
import { forms } from './routes/forms.js';
import { adPlatforms } from './routes/ad-platforms.js';
import { staff } from './routes/staff.js';
import { images } from './routes/images.js';

export type Env = {
  Bindings: {
    DB: D1Database;
    IMAGES: R2Bucket;
    LINE_CHANNEL_SECRET: string;
    LINE_CHANNEL_ACCESS_TOKEN: string;
    API_KEY: string;
    LIFF_URL: string;
    LINE_CHANNEL_ID: string;
    LINE_LOGIN_CHANNEL_ID: string;
    LINE_LOGIN_CHANNEL_SECRET: string;
    WORKER_URL: string;
    X_HARNESS_URL?: string;  // Optional: X Harness API URL for account linking
    SLACK_WEBHOOK_URL?: string; // Optional: Slack webhook for notifications
    SLACK_BOT_TOKEN?: string;
    SLACK_CHANNEL_ID?: string;
  };
  Variables: {
    staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' };
  };
};

const app = new Hono<Env>();

// CORS — allow all origins for MVP
app.use('*', cors({ origin: '*' }));

// Rate limiting — runs before auth to block abuse early
app.use('*', rateLimitMiddleware);

// Auth middleware — skips /webhook and /docs automatically
app.use('*', authMiddleware);

// Mount route groups — MVP & Round 2
app.route('/', webhook);
app.route('/', friends);
app.route('/', tags);
app.route('/', scenarios);
app.route('/', broadcasts);
app.route('/', users);
app.route('/', lineAccounts);
app.route('/', conversions);
app.route('/', affiliates);
app.route('/', openapi);
app.route('/', liffRoutes);

// Mount route groups — Round 3
app.route('/', webhooks);
app.route('/', calendar);
app.route('/', reminders);
app.route('/', scoring);
app.route('/', templates);
app.route('/', chats);
app.route('/', notifications);
app.route('/', stripe);
app.route('/', health);
app.route('/', automations);
app.route('/', richMenus);
app.route('/', trackedLinks);
app.route('/', forms);
app.route('/', adPlatforms);
app.route('/', staff);
app.route('/', images);

// DELETE /api/friends/:id — hard delete friend and all related data
app.delete('/api/friends/:id', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  await db.prepare('DELETE FROM friend_tags WHERE friend_id = ?').bind(id).run();
  await db.prepare('DELETE FROM friend_scenarios WHERE friend_id = ?').bind(id).run();
  await db.prepare('DELETE FROM messages_log WHERE friend_id = ?').bind(id).run();
  await db.prepare('DELETE FROM chats WHERE friend_id = ?').bind(id).run();
  await db.prepare('DELETE FROM ref_tracking WHERE friend_id = ?').bind(id).run();
  await db.prepare('DELETE FROM friends WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// POST /api/admin/reset-ref-tracking — clear all ref tracking data (for testing)
app.post('/api/admin/reset-ref-tracking', async (c) => {
  const db = c.env.DB;
  await db.prepare('DELETE FROM ref_tracking').run();
  return c.json({ success: true });
});

// Full schema migration endpoint — applies all CREATE TABLE IF NOT EXISTS
app.post('/api/migrate/full', async (c) => {
  const db = c.env.DB;
  const results: string[] = [];
  const tables = [
    `CREATE TABLE IF NOT EXISTS messages_log (id TEXT PRIMARY KEY, friend_id TEXT NOT NULL, direction TEXT NOT NULL, message_type TEXT NOT NULL, content TEXT NOT NULL, broadcast_id TEXT, scenario_step_id TEXT, delivery_type TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS auto_replies (id TEXT PRIMARY KEY, keyword TEXT NOT NULL, match_type TEXT NOT NULL DEFAULT 'exact', response_type TEXT NOT NULL DEFAULT 'text', response_content TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, line_account_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, friend_id TEXT NOT NULL, operator_id TEXT, status TEXT NOT NULL DEFAULT 'unread', notes TEXT, last_message_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS operators (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'operator', is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, phone TEXT, external_id TEXT, display_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS conversion_points (id TEXT PRIMARY KEY, name TEXT NOT NULL, event_type TEXT NOT NULL, value REAL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS conversion_events (id TEXT PRIMARY KEY, conversion_point_id TEXT NOT NULL, friend_id TEXT NOT NULL, user_id TEXT, affiliate_code TEXT, metadata TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS affiliates (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, commission_rate REAL NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS affiliate_clicks (id TEXT PRIMARY KEY, affiliate_id TEXT NOT NULL, url TEXT, ip_address TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS incoming_webhooks (id TEXT PRIMARY KEY, name TEXT NOT NULL, source_type TEXT NOT NULL DEFAULT 'custom', secret TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS outgoing_webhooks (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, event_types TEXT NOT NULL DEFAULT '[]', secret TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS reminder_steps (id TEXT PRIMARY KEY, reminder_id TEXT NOT NULL, offset_minutes INTEGER NOT NULL, message_type TEXT NOT NULL, message_content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS friend_reminders (id TEXT PRIMARY KEY, friend_id TEXT NOT NULL, reminder_id TEXT NOT NULL, target_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS friend_reminder_deliveries (id TEXT PRIMARY KEY, friend_reminder_id TEXT NOT NULL, reminder_step_id TEXT NOT NULL, delivered_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS scoring_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, event_type TEXT NOT NULL, score_value INTEGER NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS friend_scores (id TEXT PRIMARY KEY, friend_id TEXT NOT NULL, scoring_rule_id TEXT, score_change INTEGER NOT NULL, reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general', message_type TEXT NOT NULL, message_content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS notification_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, event_type TEXT NOT NULL, conditions TEXT NOT NULL DEFAULT '{}', channels TEXT NOT NULL DEFAULT '["webhook"]', is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, rule_id TEXT, event_type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', metadata TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, stripe_event_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, friend_id TEXT, amount REAL, currency TEXT, metadata TEXT, processed_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS account_health_logs (id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, error_code INTEGER, error_count INTEGER NOT NULL DEFAULT 0, check_period TEXT NOT NULL, risk_level TEXT NOT NULL DEFAULT 'normal', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS account_migrations (id TEXT PRIMARY KEY, from_account_id TEXT NOT NULL, to_account_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', migrated_count INTEGER NOT NULL DEFAULT 0, total_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, event_type TEXT NOT NULL, conditions TEXT NOT NULL DEFAULT '{}', actions TEXT NOT NULL DEFAULT '[]', is_active INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS automation_logs (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, friend_id TEXT, event_data TEXT, actions_result TEXT, status TEXT NOT NULL DEFAULT 'success', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS ad_platforms (id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT, config TEXT NOT NULL DEFAULT '{}', is_active INTEGER DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS ad_conversion_logs (id TEXT PRIMARY KEY, ad_platform_id TEXT NOT NULL, friend_id TEXT NOT NULL, conversion_point_id TEXT, event_name TEXT NOT NULL, click_id TEXT, click_id_type TEXT, status TEXT DEFAULT 'pending', request_body TEXT, response_body TEXT, error_message TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS entry_routes (id TEXT PRIMARY KEY, ref_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, tag_id TEXT, scenario_id TEXT, redirect_url TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS ref_tracking (id TEXT PRIMARY KEY, ref_code TEXT NOT NULL, friend_id TEXT, entry_route_id TEXT, source_url TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS google_calendar_connections (id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, access_token TEXT, refresh_token TEXT, api_key TEXT, auth_type TEXT NOT NULL DEFAULT 'api_key', is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS calendar_bookings (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, friend_id TEXT, event_id TEXT, title TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed', metadata TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  ];
  for (const sql of tables) {
    const name = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1] || '?';
    try { await db.prepare(sql).run(); results.push(`${name} ok`); }
    catch (e: any) { results.push(`${name}: ${e.message}`); }
  }
  // ALTERs
  const alters = [
    `ALTER TABLE friends ADD COLUMN ref_code TEXT`,
    `ALTER TABLE friends ADD COLUMN metadata TEXT`,
    `ALTER TABLE friends ADD COLUMN line_account_id TEXT`,
    `ALTER TABLE scenarios ADD COLUMN line_account_id TEXT`,
    `ALTER TABLE scenario_steps ADD COLUMN condition_type TEXT`,
    `ALTER TABLE scenario_steps ADD COLUMN condition_value TEXT`,
    `ALTER TABLE scenario_steps ADD COLUMN next_step_on_false INTEGER`,
    `ALTER TABLE broadcasts ADD COLUMN line_account_id TEXT`,
    `ALTER TABLE auto_replies ADD COLUMN line_account_id TEXT`,
    `ALTER TABLE ref_tracking ADD COLUMN fbclid TEXT`,
    `ALTER TABLE ref_tracking ADD COLUMN gclid TEXT`,
    `ALTER TABLE ref_tracking ADD COLUMN twclid TEXT`,
    `ALTER TABLE ref_tracking ADD COLUMN ttclid TEXT`,
    `ALTER TABLE ref_tracking ADD COLUMN utm_source TEXT`,
    `ALTER TABLE ref_tracking ADD COLUMN utm_medium TEXT`,
    `ALTER TABLE ref_tracking ADD COLUMN utm_campaign TEXT`,
    `ALTER TABLE ref_tracking ADD COLUMN user_agent TEXT`,
    `ALTER TABLE ref_tracking ADD COLUMN ip_address TEXT`,
    `ALTER TABLE line_accounts ADD COLUMN login_channel_id TEXT`,
    `ALTER TABLE line_accounts ADD COLUMN login_channel_secret TEXT`,
    `ALTER TABLE line_accounts ADD COLUMN liff_id TEXT`,
  ];
  for (const sql of alters) { try { await db.prepare(sql).run(); results.push(sql.slice(12, 60) + ' ok'); } catch {} }
  // Seed entry routes
  const routes = [
    ['web', 'Webサイト'],
    ['flyer', 'チラシ'],
    ['25-26-nagoya', '25-26 名古屋 過去参加者メール'],
    ['25-26-okayama', '25-26 岡山 過去参加者メール'],
  ];
  for (const [code, name] of routes) {
    try { await db.prepare(`INSERT OR IGNORE INTO entry_routes (id, ref_code, name) VALUES (?, ?, ?)`).bind(crypto.randomUUID(), code, name).run(); } catch {}
  }
  results.push('entry routes seeded');
  return c.json({ success: true, results });
});

// Short link: /r/:ref → landing page with LINE open button
app.get('/r/:ref', (c) => {
  const ref = c.req.param('ref');
  const liffUrl = c.env.LIFF_URL;
  if (!liffUrl) {
    return c.json({ error: 'LIFF_URL is not configured. Set it via wrangler secret put LIFF_URL.' }, 500);
  }
  const target = `${liffUrl}?ref=${encodeURIComponent(ref)}`;

  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LINE Harness</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans',system-ui,sans-serif;background:#0d1117;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{text-align:center;max-width:400px;width:90%;padding:48px 24px}
h1{font-size:28px;font-weight:800;margin-bottom:8px}
.sub{font-size:14px;color:rgba(255,255,255,0.5);margin-bottom:40px}
.btn{display:block;width:100%;padding:18px;border:none;border-radius:12px;font-size:18px;font-weight:700;text-decoration:none;text-align:center;color:#fff;background:#06C755;transition:opacity .15s}
.btn:active{opacity:.85}
.note{font-size:12px;color:rgba(255,255,255,0.3);margin-top:24px;line-height:1.6}
</style>
</head>
<body>
<div class="card">
<h1>LINE Harness</h1>
<p class="sub">L社 / U社 の無料代替 OSS</p>
<a href="${target}" class="btn">LINE で体験する</a>
<p class="note">友だち追加するだけで<br>ステップ配信・フォーム・自動返信を体験できます</p>
</div>
</body>
</html>`);
});

// 404 fallback
app.notFound((c) => c.json({ success: false, error: 'Not found' }, 404));

// Scheduled handler for cron triggers — runs for all active LINE accounts
async function scheduled(
  _event: ScheduledEvent,
  env: Env['Bindings'],
  _ctx: ExecutionContext,
): Promise<void> {
  // Get all active accounts from DB, plus the default env account
  const dbAccounts = await getLineAccounts(env.DB);
  const activeTokens = new Set<string>();

  // Default account from env
  activeTokens.add(env.LINE_CHANNEL_ACCESS_TOKEN);

  // DB accounts
  for (const account of dbAccounts) {
    if (account.is_active) {
      activeTokens.add(account.channel_access_token);
    }
  }

  // Run delivery for each account
  const jobs = [];
  for (const token of activeTokens) {
    const lineClient = new LineClient(token);
    jobs.push(
      processStepDeliveries(env.DB, lineClient, env.WORKER_URL),
      processScheduledBroadcasts(env.DB, lineClient, env.WORKER_URL),
      processReminderDeliveries(env.DB, lineClient),
    );
  }
  jobs.push(checkAccountHealth(env.DB));

  await Promise.allSettled(jobs);
}

export default {
  fetch: app.fetch,
  scheduled,
};

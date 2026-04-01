import { Hono } from 'hono';
import { verifySignature, LineClient } from '@line-crm/line-sdk';
import type { WebhookRequestBody, WebhookEvent, TextEventMessage } from '@line-crm/line-sdk';
import {
  upsertFriend,
  updateFriendFollowStatus,
  getFriendByLineUserId,
  getScenarios,
  enrollFriendInScenario,
  getScenarioSteps,
  advanceFriendScenario,
  completeFriendScenario,
  upsertChatOnMessage,
  getLineAccounts,
  getFriendTags,
  jstNow,
} from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage, expandVariables } from '../services/step-delivery.js';
import type { Env } from '../index.js';

const webhook = new Hono<Env>();

webhook.post('/webhook', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('X-Line-Signature') ?? '';
  const db = c.env.DB;

  let body: WebhookRequestBody;
  try {
    body = JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    console.error('Failed to parse webhook body');
    return c.json({ status: 'ok' }, 200);
  }

  // Multi-account: resolve credentials from DB by destination (channel user ID)
  // or fall back to environment variables (default account)
  let channelSecret = c.env.LINE_CHANNEL_SECRET;
  let channelAccessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  let matchedAccountId: string | null = null;

  if ((body as { destination?: string }).destination) {
    const accounts = await getLineAccounts(db);
    for (const account of accounts) {
      if (!account.is_active) continue;
      const isValid = await verifySignature(account.channel_secret, rawBody, signature);
      if (isValid) {
        channelSecret = account.channel_secret;
        channelAccessToken = account.channel_access_token;
        matchedAccountId = account.id;
        break;
      }
    }
  }

  // Verify with resolved secret
  const valid = await verifySignature(channelSecret, rawBody, signature);
  if (!valid) {
    console.error('Invalid LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  const lineClient = new LineClient(channelAccessToken);

  // 非同期処理 — LINE は ~1s 以内のレスポンスを要求
  const processingPromise = (async () => {
    for (const event of body.events) {
      try {
        await handleEvent(db, lineClient, event, channelAccessToken, matchedAccountId, c.env.WORKER_URL || new URL(c.req.url).origin, c.env.SLACK_BOT_TOKEN, c.env.SLACK_CHANNEL_ID);
      } catch (err) {
        console.error('Error handling webhook event:', err);
      }
    }
  })();

  c.executionCtx.waitUntil(processingPromise);

  return c.json({ status: 'ok' }, 200);
});

async function handleEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId: string | null = null,
  workerUrl?: string,
  slackBotToken?: string,
  slackChannelId?: string,
): Promise<void> {
  if (event.type === 'follow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    // プロフィール取得 & 友だち登録/更新
    let profile;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      console.error('Failed to get profile for', userId, err);
    }

    const friend = await upsertFriend(db, {
      lineUserId: userId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });

    // Set line_account_id for multi-account tracking
    if (lineAccountId) {
      await db.prepare('UPDATE friends SET line_account_id = ? WHERE id = ? AND line_account_id IS NULL')
        .bind(lineAccountId, friend.id).run();
    }

    // friend_add シナリオに登録（このアカウントのシナリオのみ）
    const scenarios = await getScenarios(db);
    for (const scenario of scenarios) {
      // Only trigger scenarios belonging to this account (or unassigned for backward compat)
      const scenarioAccountMatch = !scenario.line_account_id || !lineAccountId || scenario.line_account_id === lineAccountId;
      if (scenario.trigger_type === 'friend_add' && scenario.is_active && scenarioAccountMatch) {
        try {
          const existing = await db
            .prepare(`SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`)
            .bind(friend.id, scenario.id)
            .first<{ id: string }>();
          if (!existing) {
            const friendScenario = await enrollFriendInScenario(db, friend.id, scenario.id);

            // Immediate delivery: if the first step has delay=0, send it now via replyMessage (free)
            const steps = await getScenarioSteps(db, scenario.id);
            const firstStep = steps[0];
            if (firstStep && firstStep.delay_minutes === 0 && friendScenario.status === 'active') {
              try {
                const expandedContent = expandVariables(firstStep.message_content, friend as { id: string; display_name: string | null; user_id: string | null });
                const message = buildMessage(firstStep.message_type, expandedContent);
                try {
                  await lineClient.replyMessage(event.replyToken, [message]);
                  console.log(`Immediate delivery (reply): sent step ${firstStep.id} to ${userId}`);
                } catch {
                  // replyToken expired — fallback to push
                  await lineClient.pushMessage(userId, [message]);
                  console.log(`Immediate delivery (push fallback): sent step ${firstStep.id} to ${userId}`);
                }

                // Log outgoing message (replyMessage = 無料)
                const logId = crypto.randomUUID();
                await db
                  .prepare(
                    `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
                     VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, 'reply', ?)`,
                  )
                  .bind(logId, friend.id, firstStep.message_type, firstStep.message_content, firstStep.id, jstNow())
                  .run();

                // Advance or complete the friend_scenario
                const secondStep = steps[1] ?? null;
                if (secondStep) {
                  const nextDeliveryDate = new Date(Date.now() + 9 * 60 * 60_000);
                  nextDeliveryDate.setMinutes(nextDeliveryDate.getMinutes() + secondStep.delay_minutes);
                  // Enforce 9:00-21:00 JST delivery window
                  const h = nextDeliveryDate.getUTCHours();
                  if (h < 9 || h >= 21) {
                    if (h >= 21) nextDeliveryDate.setUTCDate(nextDeliveryDate.getUTCDate() + 1);
                    nextDeliveryDate.setUTCHours(9, 0, 0, 0);
                  }
                  await advanceFriendScenario(db, friendScenario.id, firstStep.step_order, nextDeliveryDate.toISOString().slice(0, -1) + '+09:00');
                } else {
                  await completeFriendScenario(db, friendScenario.id);
                }
              } catch (err) {
                console.error('Failed immediate delivery for scenario', scenario.id, err);
              }
            }
          }
        } catch (err) {
          console.error('Failed to enroll friend in scenario', scenario.id, err);
        }
      }
    }

    // イベントバス発火: friend_add
    await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName: friend.display_name } }, lineAccessToken, lineAccountId);
    return;
  }

  if (event.type === 'unfollow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    await updateFriendFollowStatus(db, userId, false);
    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const textMessage = event.message as TextEventMessage;
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await getFriendByLineUserId(db, userId);
    if (!friend) return;

    const incomingText = textMessage.text;
    const now = jstNow();
    const logId = crypto.randomUUID();

    // 受信メッセージをログに記録
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
         VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, ?)`,
      )
      .bind(logId, friend.id, incomingText, now)
      .run();

    // チャットを作成/更新（ユーザーの自発的メッセージのみ unread にする）
    // ボタンタップ等の自動応答キーワードは除外
    const autoKeywords = ['料金', '機能', 'API', 'フォーム', 'ヘルプ', 'UUID', 'UUID連携について教えて', 'UUID連携を確認', '配信時間', '導入支援を希望します', 'アカウント連携を見る', '体験を完了する', 'BAN対策を見る', '連携確認', 'イベントに申し込む', 'よくある質問', '高専OBに相談する'];
    const isAutoKeyword = autoKeywords.some(k => incomingText === k);
    const isTimeCommand = /(?:配信時間|配信|届けて|通知)[はを]?\s*\d{1,2}\s*時/.test(incomingText);
    if (!isAutoKeyword && !isTimeCommand) {
      await upsertChatOnMessage(db, friend.id);
    }

    // 配信時間設定: 「配信時間は○時」「○時に届けて」等のパターンを検出
    const timeMatch = incomingText.match(/(?:配信時間|配信|届けて|通知)[はを]?\s*(\d{1,2})\s*時/);
    if (timeMatch) {
      const hour = parseInt(timeMatch[1], 10);
      if (hour >= 6 && hour <= 22) {
        // Save preferred_hour to friend metadata
        const existing = await db.prepare('SELECT metadata FROM friends WHERE id = ?').bind(friend.id).first<{ metadata: string }>();
        const meta = JSON.parse(existing?.metadata || '{}');
        meta.preferred_hour = hour;
        await db.prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(meta), jstNow(), friend.id).run();

        // Reply with confirmation
        try {
          const period = hour < 12 ? '午前' : '午後';
          const displayHour = hour <= 12 ? hour : hour - 12;
          await lineClient.replyMessage(event.replyToken, [
            buildMessage('flex', JSON.stringify({
              type: 'bubble',
              body: { type: 'box', layout: 'vertical', contents: [
                { type: 'text', text: '配信時間を設定しました', size: 'lg', weight: 'bold', color: '#1e293b' },
                { type: 'box', layout: 'vertical', contents: [
                  { type: 'text', text: `${period} ${displayHour}:00`, size: 'xxl', weight: 'bold', color: '#f59e0b', align: 'center' },
                  { type: 'text', text: `（${hour}:00〜）`, size: 'sm', color: '#64748b', align: 'center', margin: 'sm' },
                ], backgroundColor: '#fffbeb', cornerRadius: 'md', paddingAll: '20px', margin: 'lg' },
                { type: 'text', text: '今後のステップ配信はこの時間以降にお届けします。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
              ], paddingAll: '20px' },
            })),
          ]);
        } catch (err) {
          console.error('Failed to reply for time setting', err);
        }
        return;
      }
    }

    // Cross-account trigger: send message from another account via UUID
    if (incomingText === '体験を完了する' && lineAccountId) {
      try {
        const friendRecord = await db.prepare('SELECT user_id FROM friends WHERE id = ?').bind(friend.id).first<{ user_id: string | null }>();
        if (friendRecord?.user_id) {
          // Find the same user on other accounts
          const otherFriends = await db.prepare(
            'SELECT f.line_user_id, la.channel_access_token FROM friends f INNER JOIN line_accounts la ON la.id = f.line_account_id WHERE f.user_id = ? AND f.line_account_id != ? AND f.is_following = 1'
          ).bind(friendRecord.user_id, lineAccountId).all<{ line_user_id: string; channel_access_token: string }>();

          for (const other of otherFriends.results) {
            const otherClient = new LineClient(other.channel_access_token);
            const { buildMessage: bm } = await import('../services/step-delivery.js');
            await otherClient.pushMessage(other.line_user_id, [bm('flex', JSON.stringify({
              type: 'bubble', size: 'giga',
              header: { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: '#fffbeb',
                contents: [{ type: 'text', text: `${friend.display_name || ''}さんへ`, size: 'lg', weight: 'bold', color: '#1e293b' }],
              },
              body: { type: 'box', layout: 'vertical', paddingAll: '20px',
                contents: [
                  { type: 'text', text: '別アカウントからのアクションを検知しました。', size: 'sm', color: '#06C755', weight: 'bold', wrap: true },
                  { type: 'text', text: 'アカウント連携が正常に動作しています。体験ありがとうございました。', size: 'sm', color: '#1e293b', wrap: true, margin: 'md' },
                  { type: 'separator', margin: 'lg' },
                  { type: 'text', text: 'ステップ配信・フォーム即返信・アカウント連携・リッチメニュー・自動返信 — 全て無料、全てOSS。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
                ],
              },
              footer: { type: 'box', layout: 'vertical', paddingAll: '16px',
                contents: [
                  { type: 'button', action: { type: 'message', label: '導入について相談する', text: '導入支援を希望します' }, style: 'primary', color: '#06C755' },
                  ...(workerUrl ? [{ type: 'button' as const, action: { type: 'uri' as const, label: 'フィードバックを送る', uri: `${workerUrl}` }, style: 'secondary' as const, margin: 'sm' as const }] : []),
                ],
              },
            }))]);
          }

          // Reply on Account ② confirming
          await lineClient.replyMessage(event.replyToken, [buildMessage('flex', JSON.stringify({
            type: 'bubble',
            body: { type: 'box', layout: 'vertical', paddingAll: '20px',
              contents: [
                { type: 'text', text: 'Account ① にメッセージを送りました', size: 'sm', color: '#06C755', weight: 'bold', align: 'center' },
                { type: 'text', text: 'Account ① のトーク画面を確認してください', size: 'xs', color: '#64748b', align: 'center', margin: 'md' },
              ],
            },
          }))]);
          return;
        }
      } catch (err) {
        console.error('Cross-account trigger error:', err);
      }
    }

    // ── リッチメニューボタン: テキストメッセージハンドラ ──
    const REGISTERED_TAG_ID = '510a566c-4a55-4712-87ae-fdad3a17a1c8';

    if (incomingText === 'イベントに申し込む') {
      try {
        const friendTags = await getFriendTags(db, friend.id);
        const isRegistered = friendTags.some(t => t.id === REGISTERED_TAG_ID);
        const tagNames = friendTags.map(t => t.name);

        if (!isRegistered) {
          // 未登録
          await lineClient.replyMessage(event.replyToken, [
            buildMessage('flex', JSON.stringify({
              type: 'bubble',
              body: {
                type: 'box', layout: 'vertical', paddingAll: '20px',
                contents: [
                  { type: 'text', text: 'まずはプロフィールを登録してください', size: 'md', weight: 'bold', color: '#1e293b', wrap: true },
                  { type: 'text', text: 'イベントへの申し込みにはプロフィール登録が必要です。', size: 'sm', color: '#64748b', wrap: true, margin: 'md' },
                ],
              },
              footer: {
                type: 'box', layout: 'vertical', paddingAll: '16px',
                contents: [
                  { type: 'button', action: { type: 'uri', label: 'プロフィールを登録する', uri: 'https://withkosen.prossell.jp/api/public/line-auth' }, style: 'primary', color: '#06C755' },
                ],
              },
            })),
          ]);
        } else {
          // 登録済み — 地区とapplied状態を判定
          const NON_ACTIVE_AREAS = ['area-東北', 'area-北海道', 'area-東海北陸'];
          const isNonActive = tagNames.some(n => NON_ACTIVE_AREAS.includes(n));
          const appliedTag = tagNames.find(n => n.startsWith('applied-'));

          if (isNonActive && !appliedTag) {
            // 非開催地区
            await lineClient.replyMessage(event.replyToken, [
              buildMessage('flex', JSON.stringify({
                type: 'bubble',
                body: {
                  type: 'box', layout: 'vertical', paddingAll: '20px',
                  contents: [
                    { type: 'text', text: 'お住まいの地区は今シーズンのISセミナー対象外です', size: 'md', weight: 'bold', color: '#1e293b', wrap: true },
                    { type: 'text', text: '冬の合同企業説明会（12月〜2月）での開催を予定しています。開催が決まり次第LINEでお知らせします！', size: 'sm', color: '#64748b', wrap: true, margin: 'md' },
                    { type: 'text', text: 'キャリアの相談はいつでも受付中です👇', size: 'sm', color: '#64748b', wrap: true, margin: 'md' },
                  ],
                },
                footer: {
                  type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
                  contents: [
                    { type: 'button', action: { type: 'message', label: '高専OBに相談する', text: '高専OBに相談する' }, style: 'primary', color: '#06C755' },
                    { type: 'button', action: { type: 'uri', label: 'イベント情報を見る', uri: 'https://withkosen.prossell.jp/event-schedule' }, style: 'link', color: '#059669' },
                  ],
                },
              })),
            ]);
          } else if (appliedTag) {
            // 申込済み
            const regionName = appliedTag.replace('applied-', '');
            await lineClient.replyMessage(event.replyToken, [
              buildMessage('flex', JSON.stringify({
                type: 'bubble',
                body: {
                  type: 'box', layout: 'vertical', paddingAll: '20px',
                  contents: [
                    { type: 'text', text: `${regionName}地区のISセミナーに申込み済みです！`, size: 'md', weight: 'bold', color: '#059669', wrap: true },
                    { type: 'text', text: '当日お会いできるのを楽しみにしています。\n開催の詳細は事前にLINEでお知らせします。', size: 'sm', color: '#64748b', wrap: true, margin: 'md' },
                  ],
                },
                footer: {
                  type: 'box', layout: 'vertical', paddingAll: '16px',
                  contents: [
                    { type: 'button', action: { type: 'uri', label: 'イベント詳細を見る', uri: 'https://withkosen.prossell.jp/event-schedule' }, style: 'link', color: '#059669' },
                  ],
                },
              })),
            ]);
          } else {
            // 登録済み・未申込・開催地区 → 地区のイベント申込を表示
            // area タグから地区を特定してシナリオのFlexを再送
            const areaTag = tagNames.find(n => n.startsWith('area-'));
            const region = areaTag ? areaTag.replace('area-', '') : null;

            if (region) {
              // 該当地区のシナリオを検索して最初のステップを送る
              const scenarios = await getScenarios(db);
              const areaScenario = scenarios.find(s =>
                s.trigger_type === 'tag_added' && s.is_active &&
                s.name.includes(region) && s.name.includes('イベント申込み')
              );
              if (areaScenario) {
                const steps = await getScenarioSteps(db, areaScenario.id);
                if (steps[0]) {
                  let expandedContent = expandVariables(steps[0].message_content, friend as { id: string; display_name: string | null; user_id: string | null; metadata?: string | null });
                  // 交通費を動的に追加
                  try {
                    const costRes = await fetch(`https://withkosen.prossell.jp/api/public/transport-cost?line_user_id=${userId}`);
                    if (costRes.ok) {
                      const costData = await costRes.json() as { transport_cost?: number | null };
                      if (costData.transport_cost != null && steps[0].message_type === 'flex') {
                        const flexJson = JSON.parse(expandedContent);
                        const costText = costData.transport_cost > 0
                          ? `💰 交通費補助: 往復${costData.transport_cost.toLocaleString()}円をサポート`
                          : '💰 交通費補助: 会場が近いため補助対象外';
                        // bodyのcontentsの最後に交通費情報を追加
                        if (flexJson.body?.contents) {
                          flexJson.body.contents.push(
                            { type: 'separator', margin: 'lg' },
                            { type: 'text', text: costText, size: 'sm', weight: 'bold', color: '#059669', wrap: true, margin: 'lg' }
                          );
                        }
                        expandedContent = JSON.stringify(flexJson);
                      }
                    }
                  } catch {}
                  const message = buildMessage(steps[0].message_type, expandedContent);
                  await lineClient.replyMessage(event.replyToken, [message]);
                } else {
                  await lineClient.replyMessage(event.replyToken, [
                    buildMessage('text', 'イベント一覧はこちらから確認できます👇\nhttps://withkosen.prossell.jp/event-schedule'),
                  ]);
                }
              } else {
                await lineClient.replyMessage(event.replyToken, [
                  buildMessage('text', 'イベント一覧はこちらから確認できます👇\nhttps://withkosen.prossell.jp/event-schedule'),
                ]);
              }
            } else {
              await lineClient.replyMessage(event.replyToken, [
                buildMessage('text', 'イベント一覧はこちらから確認できます👇\nhttps://withkosen.prossell.jp/event-schedule'),
              ]);
            }
          }
        }
      } catch (err) {
        console.error('Failed to handle イベントに申し込む:', err);
      }
      return;
    }

    if (incomingText === 'よくある質問') {
      try {
        await lineClient.replyMessage(event.replyToken, [
          buildMessage('flex', JSON.stringify({
            type: 'bubble',
            header: {
              type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: '#06C755',
              contents: [
                { type: 'text', text: 'よくある質問', size: 'lg', weight: 'bold', color: '#ffffff' },
              ],
            },
            body: {
              type: 'box', layout: 'vertical', paddingAll: '20px', spacing: 'lg',
              contents: [
                {
                  type: 'box', layout: 'vertical', spacing: 'sm',
                  contents: [
                    { type: 'text', text: 'Q. イベントの参加費は？', size: 'sm', weight: 'bold', color: '#1e293b', wrap: true },
                    { type: 'text', text: 'A. 無料です。交通費の補助もあります。', size: 'sm', color: '#64748b', wrap: true },
                  ],
                },
                { type: 'separator' },
                {
                  type: 'box', layout: 'vertical', spacing: 'sm',
                  contents: [
                    { type: 'text', text: 'Q. 服装は？', size: 'sm', weight: 'bold', color: '#1e293b', wrap: true },
                    { type: 'text', text: 'A. 私服でOKです。', size: 'sm', color: '#64748b', wrap: true },
                  ],
                },
                { type: 'separator' },
                {
                  type: 'box', layout: 'vertical', spacing: 'sm',
                  contents: [
                    { type: 'text', text: 'Q. 持ち物は？', size: 'sm', weight: 'bold', color: '#1e293b', wrap: true },
                    { type: 'text', text: 'A. 特にありません。筆記用具があると便利です。', size: 'sm', color: '#64748b', wrap: true },
                  ],
                },
                { type: 'separator' },
                {
                  type: 'box', layout: 'vertical', spacing: 'sm',
                  contents: [
                    { type: 'text', text: 'Q. 途中参加・退出は？', size: 'sm', weight: 'bold', color: '#1e293b', wrap: true },
                    { type: 'text', text: 'A. 可能ですが、全プログラム参加をおすすめします。', size: 'sm', color: '#64748b', wrap: true },
                  ],
                },
              ],
            },
          })),
        ]);
      } catch (err) {
        console.error('Failed to handle よくある質問:', err);
      }
      return;
    }

    if (incomingText === '高専OBに相談する') {
      try {
        await lineClient.replyMessage(event.replyToken, [
          buildMessage('flex', JSON.stringify({
            type: 'bubble',
            body: {
              type: 'box', layout: 'vertical', paddingAll: '20px',
              contents: [
                { type: 'text', text: '高専OB/OGがキャリアの相談に乗ります！', size: 'md', weight: 'bold', color: '#1e293b', wrap: true },
                { type: 'text', text: '以下から相談内容を選んでください', size: 'sm', color: '#64748b', wrap: true, margin: 'md' },
              ],
            },
            footer: {
              type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
              contents: [
                { type: 'button', action: { type: 'postback', label: '就活について相談したい', data: 'ob_consult_shukatsu', displayText: '就活について相談したい' }, style: 'primary', color: '#06C755' },
                { type: 'button', action: { type: 'postback', label: 'インターンについて相談したい', data: 'ob_consult_intern', displayText: 'インターンについて相談したい' }, style: 'secondary' },
                { type: 'button', action: { type: 'postback', label: 'キャリア全般の相談', data: 'ob_consult_career', displayText: 'キャリア全般の相談' }, style: 'secondary' },
              ],
            },
          })),
        ]);
      } catch (err) {
        console.error('Failed to handle 高専OBに相談する:', err);
      }
      return;
    }

    // 自動返信チェック（このアカウントのルール + グローバルルールのみ）
    // NOTE: Auto-replies use replyMessage (free, no quota) instead of pushMessage
    // The replyToken is only valid for ~1 minute after the message event
    const autoReplyQuery = lineAccountId
      ? `SELECT * FROM auto_replies WHERE is_active = 1 AND (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at ASC`
      : `SELECT * FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at ASC`;
    const autoReplyStmt = db.prepare(autoReplyQuery);
    const autoReplies = await (lineAccountId ? autoReplyStmt.bind(lineAccountId) : autoReplyStmt)
      .all<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains';
        response_type: string;
        response_content: string;
        is_active: number;
        created_at: string;
      }>();

    let matched = false;
    for (const rule of autoReplies.results) {
      const isMatch =
        rule.match_type === 'exact'
          ? incomingText === rule.keyword
          : incomingText.includes(rule.keyword);

      if (isMatch) {
        try {
          // Expand template variables ({{name}}, {{uid}}, {{auth_url:CHANNEL_ID}})
          const expandedContent = expandVariables(rule.response_content, friend as { id: string; display_name: string | null; user_id: string | null }, workerUrl);
          const replyMsg = buildMessage(rule.response_type, expandedContent);
          await lineClient.replyMessage(event.replyToken, [replyMsg]);

          // 送信ログ（replyMessage = 無料）
          const outLogId = crypto.randomUUID();
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', ?)`,
            )
            .bind(outLogId, friend.id, rule.response_type, rule.response_content, jstNow())
            .run();
        } catch (err) {
          console.error('Failed to send auto-reply', err);
        }

        matched = true;
        break;
      }
    }

    // 自動返信にもリッチメニューにもマッチしなかった場合のキャッチオール応答
    if (!matched) {
      try {
        await lineClient.replyMessage(event.replyToken, [
          buildMessage('flex', JSON.stringify({
            type: 'bubble',
            body: {
              type: 'box', layout: 'vertical', paddingAll: '20px',
              contents: [
                { type: 'text', text: 'お問い合わせありがとうございます！', size: 'md', weight: 'bold', color: '#1e293b', wrap: true },
                { type: 'text', text: '以下から該当するものを選んでください', size: 'sm', color: '#64748b', wrap: true, margin: 'md' },
              ],
            },
            footer: {
              type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
              contents: [
                { type: 'button', action: { type: 'postback', label: '質問する', data: `inquiry_question&msg=${encodeURIComponent(incomingText.slice(0, 100))}`, displayText: '質問する' }, style: 'primary', color: '#06C755' },
                { type: 'button', action: { type: 'postback', label: '高専OB/OGに相談する', data: `inquiry_ob&msg=${encodeURIComponent(incomingText.slice(0, 100))}`, displayText: '高専OB/OGに相談する' }, style: 'secondary' },
                { type: 'button', action: { type: 'postback', label: '間違いでした', data: 'inquiry_mistake', displayText: '間違いでした' }, style: 'secondary' },
              ],
            },
          })),
        ]);
      } catch (err) {
        console.error('Failed to send catch-all reply:', err);
      }
    }

    // イベントバス発火: message_received
    await fireEvent(db, 'message_received', {
      friendId: friend.id,
      eventData: { text: incomingText, matched },
    }, lineAccessToken, lineAccountId);

    return;
  }

  // Handle postback events (e.g., event registration from Flex Message buttons)
  if (event.type === 'postback') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const postbackData = (event as unknown as { postback: { data: string } }).postback?.data;
    if (!postbackData) return;

    // OB相談・質問のpostbackハンドラ
    const pbParams = new URLSearchParams(postbackData);
    const pbAction = pbParams.get('action') || postbackData.split('&')[0];
    const userMessage = pbParams.get('msg') ? decodeURIComponent(pbParams.get('msg')!) : '';

    if (pbAction.startsWith('ob_consult_') || pbAction === 'inquiry_question' || postbackData.startsWith('ob_consult_') || postbackData.startsWith('inquiry_question')) {
      const friend = await getFriendByLineUserId(db, userId);
      if (!friend) return;

      const labels: Record<string, string> = {
        ob_consult_shukatsu: '就活について',
        ob_consult_intern: 'インターンについて',
        ob_consult_career: 'キャリア全般',
        inquiry_question: '質問',
      };
      const label = labels[pbAction] || labels[postbackData.split('&')[0]] || pbAction;

      // Harnessのチャットを作成
      try {
        const chatId = crypto.randomUUID();
        const now = jstNow();
        await db.prepare(
          `INSERT INTO chats (id, friend_id, status, notes, created_at, updated_at) VALUES (?, ?, 'unread', ?, ?, ?)`
        ).bind(chatId, friend.id, `${label}の相談`, now, now).run();

        // Slack通知 (Bot Token方式)
        if (slackBotToken && slackChannelId) {
          const meta = JSON.parse(friend.metadata || '{}');
          const displayName = meta.real_name || friend.display_name || '不明';
          await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${slackBotToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              channel: slackChannelId,
              text: `📩 LINE相談リクエスト\n*${displayName}* さんが「${label}」の相談を希望しています${userMessage ? `\n\n💬 元メッセージ: ${userMessage}` : ''}\n\n<https://with-kosen-line-admin.vercel.app/chats|管理画面で返信する>`,
            }),
          });
        }
      } catch (err) {
        console.error('Failed to create chat/notify:', err);
      }

      if (event.replyToken) {
        try {
          await lineClient.replyMessage(event.replyToken, [
            buildMessage('text', 'ありがとうございます！担当者に通知しました。\n少々お待ちください 🙏'),
          ]);
        } catch {}
      }
      return;
    }

    if (pbAction === 'inquiry_ob' || postbackData.startsWith('inquiry_ob')) {
      if (event.replyToken) {
        try {
          await lineClient.replyMessage(event.replyToken, [
            buildMessage('flex', JSON.stringify({
              type: 'bubble',
              body: {
                type: 'box', layout: 'vertical', paddingAll: '20px',
                contents: [
                  { type: 'text', text: '高専OB/OGがキャリアの相談に乗ります！', size: 'md', weight: 'bold', color: '#1e293b', wrap: true },
                  { type: 'text', text: '以下から相談内容を選んでください', size: 'sm', color: '#64748b', wrap: true, margin: 'md' },
                ],
              },
              footer: {
                type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
                contents: [
                  { type: 'button', action: { type: 'postback', label: '就活について相談したい', data: `ob_consult_shukatsu${userMessage ? '&msg=' + encodeURIComponent(userMessage) : ''}`, displayText: '就活について相談したい' }, style: 'primary', color: '#06C755' },
                  { type: 'button', action: { type: 'postback', label: 'インターンについて相談したい', data: `ob_consult_intern${userMessage ? '&msg=' + encodeURIComponent(userMessage) : ''}`, displayText: 'インターンについて相談したい' }, style: 'secondary' },
                  { type: 'button', action: { type: 'postback', label: 'キャリア全般の相談', data: `ob_consult_career${userMessage ? '&msg=' + encodeURIComponent(userMessage) : ''}`, displayText: 'キャリア全般の相談' }, style: 'secondary' },
                ],
              },
            })),
          ]);
        } catch {}
      }
      return;
    }

    if (pbAction === 'inquiry_mistake' || postbackData === 'inquiry_mistake') {
      if (event.replyToken) {
        try {
          await lineClient.replyMessage(event.replyToken, [
            buildMessage('text', '了解しました！何かあればお気軽にメッセージください 😊'),
          ]);
        } catch {}
      }
      return;
    }

    const params = new URLSearchParams(postbackData);
    const action = params.get('action');

    if (action === 'apply_event') {
      const venueId = params.get('venue_id');
      const region = params.get('region');
      const appliedTagId = params.get('applied_tag');

      if (!venueId) return;

      // Call Platform API to create registration
      const platformUrl = 'https://admin.withkosen.prossell.jp/api/public/apply-event';
      try {
        const res = await fetch(platformUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ line_user_id: userId, venue_id: venueId, region }),
        });
        const data = await res.json() as { success?: boolean; already_registered?: boolean; error?: string; student_name?: string; school_name?: string; grade?: number; registration_count?: number };

        // Add applied tag in Harness
        if (appliedTagId && (data.success || data.already_registered)) {
          const friend = await getFriendByLineUserId(db, userId);
          if (friend) {
            const { addTagToFriend } = await import('@line-crm/db');
            try {
              await addTagToFriend(db, friend.id, appliedTagId);
            } catch {
              // Tag might already exist
            }
          }
        }

        // Reply to user
        if (event.replyToken) {
          if (data.already_registered) {
            await lineClient.replyMessage(event.replyToken, [
              buildMessage('text', '既に参加申込み済みです！\n当日お会いできるのを楽しみにしています。'),
            ]);
          } else if (data.success) {
            await lineClient.replyMessage(event.replyToken, [
              buildMessage('text', `参加申込みを受け付けました！🎉\n\n${region ? `${region}地区の` : ''}ISセミナーでお会いしましょう。\n当日の詳細は開催前にお知らせします。`),
            ]);
            // Slack通知
            if (slackBotToken && slackChannelId) {
              const gradeLabel = data.grade
                ? data.grade >= 6 ? `専攻科${data.grade - 5}年` : `本科${data.grade}年`
                : '';
              await fetch('https://slack.com/api/chat.postMessage', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${slackBotToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  channel: slackChannelId,
                  text: `🎉 イベント参加申込み\n*${data.student_name || '不明'}* さんが${region ? `${region}地区の` : ''}ISセミナーに申し込みました\n\n🏫 ${data.school_name || '不明'} ${gradeLabel}\n📊 ${region || ''}地区 ${data.registration_count}人目の申込み`,
                }),
              });
            }
          } else if (data.error === 'student_not_found') {
            await lineClient.replyMessage(event.replyToken, [
              buildMessage('text', '先にプロフィール登録をお願いします。\n\nhttps://admin.withkosen.prossell.jp/api/public/line-auth'),
            ]);
          } else {
            await lineClient.replyMessage(event.replyToken, [
              buildMessage('text', '申込みの処理中にエラーが発生しました。時間をおいて再度お試しください。'),
            ]);
          }
        }
      } catch (err) {
        console.error('Failed to process apply_event postback:', err);
        if (event.replyToken) {
          try {
            await lineClient.replyMessage(event.replyToken, [
              buildMessage('text', '申込みの処理中にエラーが発生しました。時間をおいて再度お試しください。'),
            ]);
          } catch {}
        }
      }
    }

    // OB相談・質問系 postback ハンドラ
    if (postbackData.startsWith('ob_consult_') || postbackData === 'inquiry_question') {
      try {
        await lineClient.replyMessage(event.replyToken, [
          buildMessage('text', 'ありがとうございます！担当者に通知しました。少々お待ちください。'),
        ]);

        // Slack通知（SLACK_WEBHOOK_URL が設定されている場合）
        const friend = await getFriendByLineUserId(db, userId);
        const displayName = friend?.display_name || userId;
        const label = postbackData === 'inquiry_question' ? '質問'
          : postbackData === 'ob_consult_shukatsu' ? 'OB相談: 就活'
          : postbackData === 'ob_consult_intern' ? 'OB相談: インターン'
          : 'OB相談: キャリア全般';

        if (slackBotToken && slackChannelId) {
          try {
            await fetch('https://slack.com/api/chat.postMessage', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${slackBotToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                channel: slackChannelId,
                text: `📩 [With Kosen LINE] ${displayName} さんから「${label}」のリクエストがありました。\n<https://with-kosen-line-admin.vercel.app/chats|管理画面で確認>`,
              }),
            });
          } catch (slackErr) {
            console.error('Failed to send Slack notification:', slackErr);
          }
        } else {
          console.log(`[Slack notification] ${displayName} さんから「${label}」のリクエスト (SLACK_WEBHOOK_URL未設定)`);
        }
      } catch (err) {
        console.error('Failed to handle ob_consult/inquiry_question postback:', err);
      }
    }

    // inquiry_ob: 高専OBに相談するメニューを表示
    if (postbackData === 'inquiry_ob') {
      try {
        await lineClient.replyMessage(event.replyToken, [
          buildMessage('flex', JSON.stringify({
            type: 'bubble',
            body: {
              type: 'box', layout: 'vertical', paddingAll: '20px',
              contents: [
                { type: 'text', text: '高専OB/OGがキャリアの相談に乗ります！', size: 'md', weight: 'bold', color: '#1e293b', wrap: true },
                { type: 'text', text: '以下から相談内容を選んでください', size: 'sm', color: '#64748b', wrap: true, margin: 'md' },
              ],
            },
            footer: {
              type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
              contents: [
                { type: 'button', action: { type: 'postback', label: '就活について相談したい', data: 'ob_consult_shukatsu', displayText: '就活について相談したい' }, style: 'primary', color: '#06C755' },
                { type: 'button', action: { type: 'postback', label: 'インターンについて相談したい', data: 'ob_consult_intern', displayText: 'インターンについて相談したい' }, style: 'secondary' },
                { type: 'button', action: { type: 'postback', label: 'キャリア全般の相談', data: 'ob_consult_career', displayText: 'キャリア全般の相談' }, style: 'secondary' },
              ],
            },
          })),
        ]);
      } catch (err) {
        console.error('Failed to handle inquiry_ob postback:', err);
      }
    }

    // inquiry_mistake: 間違いでしたの応答
    if (postbackData === 'inquiry_mistake') {
      try {
        await lineClient.replyMessage(event.replyToken, [
          buildMessage('text', '了解しました！何かあればお気軽にメッセージください😊'),
        ]);
      } catch (err) {
        console.error('Failed to handle inquiry_mistake postback:', err);
      }
    }

    return;
  }
}

export { webhook };

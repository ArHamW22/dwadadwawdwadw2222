const BOT_TOKEN  = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const LRM_KEY    = process.env.LRM_KEY;
const LRM_PID    = process.env.LRM_PID;
const MAX_SLOTS  = 7;
const LOADER_URL = process.env.LOADER_URL;

const http = require('http');
http.createServer((req, res) => res.end('online')).listen(process.env.PORT || 3000);

let panelMessageId = null;

function parseDuration(str) {
    const match = str.match(/^(\d+)(h|d|w)$/i);
    if (!match) return null;
    const num = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === 'h') return { seconds: num * 3600, label: `${num} hour${num !== 1 ? 's' : ''}` };
    if (unit === 'd') return { seconds: num * 86400, label: `${num} day${num !== 1 ? 's' : ''}` };
    if (unit === 'w') return { seconds: num * 604800, label: `${num} week${num !== 1 ? 's' : ''}` };
    return null;
}

async function discordRequest(method, path, body) {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
        method,
        headers: {
            'Authorization': `Bot ${BOT_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
        const t = await res.text();
        console.log(`[Discord] ${method} ${path} failed:`, t.slice(0, 200));
        return null;
    }
    return res.json();
}

async function getAllUsers() {
    const res = await fetch(`https://api.luarmor.net/v3/projects/${LRM_PID}/users`, {
        headers: { 'Authorization': LRM_KEY, 'Content-Type': 'application/json' }
    });
    if (!res.ok) return [];
    const d = await res.json();
    return d.users || [];
}

async function createKey(durationSeconds, discordId, label) {
    const auth_expire = Math.floor(Date.now() / 1000) + durationSeconds;
    const body = { auth_expire, discord_id: discordId, note: `Cerberus slot — ${label}` };
    const res = await fetch(`https://api.luarmor.net/v3/projects/${LRM_PID}/users`, {
        method: 'POST',
        headers: { 'Authorization': LRM_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const d = await res.json();
    if (!d.success) { console.log('[Luarmor] createKey failed:', d); return null; }
    return d.user_key;
}

async function revokeKey(userKey) {
    const res = await fetch(`https://api.luarmor.net/v3/projects/${LRM_PID}/users?user_key=${encodeURIComponent(userKey)}`, {
        method: 'DELETE',
        headers: { 'Authorization': LRM_KEY, 'Content-Type': 'application/json' }
    });
    return res.ok;
}

async function getKeyByDiscordId(discordId) {
    const users = await getAllUsers();
    return users.find(u => u.discord_id === discordId) || null;
}

function formatTime(secs) {
    if (secs <= 0) return 'Expired';
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

async function updatePanel() {
    const now = Math.floor(Date.now() / 1000);
    const users = await getAllUsers();
    const active = users.filter(u => !u.banned && (u.auth_expire === -1 || u.auth_expire > now));
    const used = active.length;
    const available = MAX_SLOTS - used;
    const full = used >= MAX_SLOTS;

    const lines = active.length > 0
        ? active.map((u, i) => {
            const tag = u.discord_id ? `<@${u.discord_id}>` : `\`${u.user_key.slice(0,8)}...\``;
            const time = u.auth_expire === -1 ? '∞' : formatTime(u.auth_expire - now);
            return `${i+1}. ${tag} → ${time} remaining`;
        }).join('\n')
        : 'No active slots';

    const embed = {
        title: `🐕 Cerberus Notifier — Slots (${used}/${MAX_SLOTS})`,
        description: lines,
        color: full ? 0xDE3163 : 0x00AF41,
        footer: { text: 'Cerberus Notifier • Updates every 60s' },
        timestamp: new Date().toISOString(),
        fields: [{
            name: full ? '⛔ All slots are full' : `✅ ${available} slot${available !== 1 ? 's' : ''} available`,
            value: full ? 'Check back later or DM for waitlist' : 'DM to purchase a slot',
            inline: false
        }]
    };

    if (!panelMessageId) {
        const msg = await discordRequest('POST', `/channels/${CHANNEL_ID}/messages`, { embeds: [embed] });
        if (msg) { panelMessageId = msg.id; console.log('[Panel] Posted:', panelMessageId); }
    } else {
        await discordRequest('PATCH', `/channels/${CHANNEL_ID}/messages/${panelMessageId}`, { embeds: [embed] });
        console.log('[Panel] Updated at', new Date().toLocaleTimeString());
    }
}

async function handleMessage(msg) {
    if (msg.author?.bot) return;
    const content = msg.content?.trim();
    if (!content?.startsWith('!')) return;

    const parts = content.split(' ');
    const cmd = parts[0].toLowerCase();

    if (cmd === '!addslot') {
        const mention = parts[1];
        const durationStr = parts[2];
        if (!mention || !durationStr) {
            return discordRequest('POST', `/channels/${msg.channel_id}/messages`, {
                content: '❌ Usage: `!addslot @user <duration>` e.g. `!addslot @user 1h` or `!addslot @user 7d`'
            });
        }
        const duration = parseDuration(durationStr);
        if (!duration) {
            return discordRequest('POST', `/channels/${msg.channel_id}/messages`, {
                content: '❌ Invalid duration. Use `1h`, `7d`, `2w` etc.'
            });
        }
        const discordId = mention.replace(/[<@!>]/g, '');
        const now = Math.floor(Date.now() / 1000);
        const users = await getAllUsers();
        const active = users.filter(u => !u.banned && (u.auth_expire === -1 || u.auth_expire > now));
        if (active.length >= MAX_SLOTS) {
            return discordRequest('POST', `/channels/${msg.channel_id}/messages`, {
                content: '❌ All slots are full!'
            });
        }
        const existing = await getKeyByDiscordId(discordId);
        if (existing && (existing.auth_expire === -1 || existing.auth_expire > now)) {
            return discordRequest('POST', `/channels/${msg.channel_id}/messages`, {
                content: `❌ <@${discordId}> already has an active slot.`
            });
        }
        const key = await createKey(duration.seconds, discordId, duration.label);
        if (!key) {
            return discordRequest('POST', `/channels/${msg.channel_id}/messages`, {
                content: '❌ Failed to create key on Luarmor.'
            });
        }
        const dmChannel = await discordRequest('POST', '/users/@me/channels', { recipient_id: discordId });
        if (dmChannel) {
            await discordRequest('POST', `/channels/${dmChannel.id}/messages`, {
                embeds: [{
                    title: '🐕 Cerberus Notifier — Your Key',
                    description: `Your slot is active for **${duration.label}**.\n\nHead to the Cerberus panel in the Discord server and click **Redeem Key** to activate your slot.`,
                    color: 0x00AF41,
                    fields: [
                        { name: '🔑 Your Key', value: `\`${key}\``, inline: false },
                        { name: '⏰ Duration', value: duration.label, inline: true }
                    ],
                    footer: { text: 'Cerberus Notifier • gg/cerberusnotifier' }
                }]
            });
        }
        await discordRequest('POST', `/channels/${msg.channel_id}/messages`, {
            content: `✅ Slot added for <@${discordId}> — **${duration.label}**. Key sent via DM.`
        });
        updatePanel();
    }

    if (cmd === '!removeslot') {
        const mention = parts[1];
        if (!mention) {
            return discordRequest('POST', `/channels/${msg.channel_id}/messages`, {
                content: '❌ Usage: `!removeslot @user`'
            });
        }
        const discordId = mention.replace(/[<@!>]/g, '');
        const user = await getKeyByDiscordId(discordId);
        if (!user) {
            return discordRequest('POST', `/channels/${msg.channel_id}/messages`, {
                content: `❌ No key found for <@${discordId}>.`
            });
        }
        await revokeKey(user.user_key);
        await discordRequest('POST', `/channels/${msg.channel_id}/messages`, {
            content: `✅ Slot removed for <@${discordId}>.`
        });
        updatePanel();
    }

    if (cmd === '!slots') {
        const now = Math.floor(Date.now() / 1000);
        const users = await getAllUsers();
        const active = users.filter(u => !u.banned && (u.auth_expire === -1 || u.auth_expire > now));
        await discordRequest('POST', `/channels/${msg.channel_id}/messages`, {
            content: `📊 Active slots: **${active.length}/${MAX_SLOTS}**`
        });
    }

    if (cmd === '!help') {
        await discordRequest('POST', `/channels/${msg.channel_id}/messages`, {
            embeds: [{
                title: '🐕 Cerberus Bot Commands',
                color: 0x00AF41,
                fields: [
                    { name: '!addslot @user <duration>', value: 'Add a slot. Examples: `1h` `12h` `7d` `2w`', inline: false },
                    { name: '!removeslot @user', value: 'Remove a slot from a user', inline: false },
                    { name: '!slots', value: 'Show active slot count', inline: false },
                ]
            }]
        });
    }
}

const WebSocket = require('ws');
let ws;
let heartbeatInterval;
let sequence = null;

function startGateway() {
    ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');

    ws.on('open', () => console.log('[Gateway] Connected'));

    ws.on('message', async (data) => {
        const payload = JSON.parse(data);
        const { op, d, t, s } = payload;
        if (s) sequence = s;

        if (op === 10) {
            heartbeatInterval = setInterval(() => {
                ws.send(JSON.stringify({ op: 1, d: sequence }));
            }, d.heartbeat_interval);
            ws.send(JSON.stringify({
                op: 2,
                d: {
                    token: BOT_TOKEN,
                    intents: 33280,
                    properties: { os: 'linux', browser: 'cerberus', device: 'cerberus' }
                }
            }));
        }

        if (op === 0 && t === 'READY') {
            console.log('[Gateway] Bot ready:', d.user.username);
            updatePanel();
        }

        if (op === 0 && t === 'MESSAGE_CREATE') {
            await handleMessage(d);
        }
    });

    ws.on('close', (code) => {
        console.log('[Gateway] Closed:', code, '— reconnecting in 5s');
        clearInterval(heartbeatInterval);
        setTimeout(startGateway, 5000);
    });

    ws.on('error', (err) => console.log('[Gateway] Error:', err.message));
}

startGateway();
setInterval(updatePanel, 60_000);

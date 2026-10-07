const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');

// ==================== 配置区 ====================
const CONFIG = {
    host: 'cn-hz1.mfrp.space',
    port: 23323,
    username: '79Bot',
    auth: 'offline',
    version: '1.20.1',
    keepAlive: true,
    pingInterval: 15000,
    skinPlayer: 'GeorgeNotFound',  // SkinsRestorer 皮肤角色名，登录后自动执行 /skin <角色名>
};

const BOT_PASSWORD = 'hfsadhbsfb';
const ADMIN_PLAYERS = ['Liying_79', 'LOWLIFE'];

// 白名单数据文件路径
const AUTH_FILE = path.join(__dirname, 'authorized_users.json');

// 服务器指令前缀
const CMD_PREFIX = {
    tell: '/minecraft:tell',
    tpa: '/tpa',
    tpaccept: '/tpaccept',
};

// 已经注册过的标记，重连后只发 /login
let hasRegistered = false;

// ==================== 全局状态 ====================
let currentBot = null;
let authCompleted = false;
const timers = [];
function registerTimer(t) { timers.push(t); return t; }
function clearAllTimers() { timers.forEach(t => clearTimeout(t)); timers.length = 0; }

// 代登机器人管理
const proxyBots = new Map(); // key: 玩家名, value: { bot, timer, admin }
const MAX_PROXY_BOTS = 5;   // 最多同时代登5个账号，防止资源耗尽

// 全局兜底，绝不让进程崩溃
process.on('uncaughtException', (err) => console.error('[全局异常]', err.message));
process.on('unhandledRejection', (r) => console.error('[Promise拒绝]', r));

// ==================== 白名单管理 ====================
function loadAuthorizedUsers() {
    try {
        if (fs.existsSync(AUTH_FILE)) {
            const data = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
            const now = Date.now();
            const valid = {};
            for (const [name, info] of Object.entries(data)) {
                if (info.expireAt > now) {
                    valid[name] = info;
                }
            }
            return valid;
        }
    } catch (e) {
        console.error('[79Bot] 读取白名单文件失败:', e.message);
    }
    return {};
}

function saveAuthorizedUsers(users) {
    try {
        fs.writeFileSync(AUTH_FILE, JSON.stringify(users, null, 2), 'utf8');
    } catch (e) {
        console.error('[79Bot] 保存白名单文件失败:', e.message);
    }
}

function hasPermission(username) {
    if (ADMIN_PLAYERS.includes(username)) return true;
    const users = loadAuthorizedUsers();
    const info = users[username];
    if (!info) return false;
    if (info.expireAt <= Date.now()) {
        delete users[username];
        saveAuthorizedUsers(users);
        return false;
    }
    return true;
}

function grantPermission(playerName, days) {
    const users = loadAuthorizedUsers();
    users[playerName] = {
        grantedBy: 'admin',
        grantedAt: Date.now(),
        expireAt: Date.now() + days * 24 * 60 * 60 * 1000,
    };
    saveAuthorizedUsers(users);
}

function revokePermission(playerName) {
    const users = loadAuthorizedUsers();
    delete users[playerName];
    saveAuthorizedUsers(users);
}

// ==================== 安全发言 ====================
function safeSay(text) {
    if (!currentBot) return;
    const clean = String(text).replace(/\u00a7./g, '').replace(/[\u0000-\u001f\u007f\u00a7]/g, '');
    try { currentBot.chat(clean); } catch (e) {}
}

// ==================== 私聊发送（带延迟防刷屏）====================
function tellPlayer(bot, playerName, text) {
    const clean = String(text).replace(/\u00a7./g, '').replace(/[\u0000-\u001f\u007f\u00a7]/g, '');
    try { bot.chat(`${CMD_PREFIX.tell} ${playerName} ${clean}`); } catch (e) {}
}

function tellLines(bot, playerName, lines) {
    let delay = 0;
    for (const line of lines) {
        registerTimer(setTimeout(() => tellPlayer(bot, playerName, line), delay));
        delay += 300;
    }
}

// ==================== 皮肤设置（SkinsRestorer /skin 指令）====================
// 服务器装了 SkinsRestorer 插件，正确方式是发送 /skin <角色名> 指令来设置皮肤，
// 而不是调用 mineflayer 原生不存在的皮肤接口。
function applySkinByName(bot, tag) {
    if (!CONFIG.skinPlayer) return;
    try {
        const cmd = `/skin ${CONFIG.skinPlayer}`;
        bot.chat(cmd);
        console.log(`${tag} 已发送皮肤指令: ${cmd}`);
    } catch (e) {
        console.error(`${tag} 皮肤指令发送失败:`, e.message);
    }
}

// ==================== 启动主机器人 ====================
function startBot() {
    clearAllTimers();
    authCompleted = false;

    const bot = mineflayer.createBot(CONFIG);
    currentBot = bot;

    bot.on('login', () => console.log('[79Bot] 已连接服务器，等待登录提示...'));

    bot.on('spawn', () => {
        console.log('[79Bot] 已生成');
        registerTimer(setTimeout(() => {
            if (currentBot === bot) safeSay('79Bot 已上线，管理员输入 79Bot /help 查看帮助');
        }, 3000));
    });

    bot.on('error', (err) => console.error('[79Bot 错误]', err.message));
    bot.on('kicked', (reason) => console.log('[79Bot 被踢]', reason));
    bot.on('end', (reason) => {
        console.log('[79Bot] 连接断开:', reason);
        clearAllTimers();
        authCompleted = false;
        currentBot = null;
        registerTimer(setTimeout(startBot, 8000));
    });

    // ---------- 自动登录/注册 ----------
    bot.on('message', (jsonMsg) => {
        if (authCompleted) return;
        const msgText = jsonMsg.toString();
        console.log('[79Bot 消息]', msgText);

        if (!/\[玩家系统\]/.test(msgText)) return;

        if (/\/register/.test(msgText) || /以注册/.test(msgText)) {
            console.log('[79Bot] 检测到注册提示');
            scheduleAuth(bot, 'register');
            return;
        }
        if (/\/login/.test(msgText) || /以登录/.test(msgText)) {
            console.log('[79Bot] 检测到登录提示');
            scheduleAuth(bot, 'login');
            return;
        }
    });

    // ---------- 命令系统 ----------
    bot.on('chat', (username, message) => {
        if (username === bot.username) return;

        const msg = message.trim();
        let cmd = '';
        let type = 'chat';

        if (msg.startsWith('79Bot')) {
            cmd = msg.slice(5).trim();
        } else {
            const m = msg.match(/^(?:w|msg|tell)\s+79Bot\s+(.+)$/i);
            if (m) { cmd = m[1].trim(); type = 'private'; }
        }
        if (!cmd) return;

        if (!hasPermission(username)) {
            return;
        }

        console.log(`[79Bot] 收到 ${username} 的${type === 'private' ? '私聊' : '公聊'}指令: ${cmd}`);
        handleCommand(bot, cmd, type, username);
    });

    // ---------- 监听服务器对指令的响应 ----------
    bot.on('message', (jsonMsg) => {
        if (!authCompleted) return;
        const msgText = jsonMsg.toString();
        const clean = msgText.replace(/\u00a7./g, '').replace(/[\u0000-\u001f\u007f\u00a7]/g, '');

        if (/tpaccept|tpa|传送|teleport|accept|request/i.test(clean)) {
            console.log('[79Bot TP反馈]', clean);
        }
    });

    // ---------- 日出日落提醒 ----------
    let lastSunrise = 0, lastSunset = 0;
    bot.on('time', () => {
        const t = bot.time.timeOfDay, now = Date.now();
        if (t >= 0 && t <= 200 && now - lastSunrise > 60000) {
            safeSay('天亮了！游戏时间早上6点，新的一天开始了');
            lastSunrise = now;
        }
        if (t >= 12000 && t <= 12200 && now - lastSunset > 60000) {
            safeSay('天黑了！游戏时间晚上6点，注意怪物出没');
            lastSunset = now;
        }
    });
}

function scheduleAuth(bot, type) {
    if (authCompleted) return;
    registerTimer(setTimeout(() => {
        if (currentBot !== bot) return;
        try {
            if (type === 'register' && !hasRegistered) {
                bot.chat(`/register ${BOT_PASSWORD} ${BOT_PASSWORD}`);
                hasRegistered = true;
                console.log('[79Bot] 已发送注册指令');
            } else {
                bot.chat(`/login ${BOT_PASSWORD}`);
                console.log('[79Bot] 已发送登录指令');
            }
            authCompleted = true;
            // 登录成功后自动设置皮肤（SkinsRestorer /skin 指令）
            registerTimer(setTimeout(() => {
                if (currentBot === bot) applySkinByName(bot, '[79Bot]');
            }, 1500));
        } catch (e) {
            console.error('[79Bot 认证失败]', e.message);
        }
    }, 800));
}

// ==================== 命令处理 ====================
function handleCommand(bot, cmd, type, adminName) {
    const reply = (text) => {
        const clean = String(text).replace(/\u00a7./g, '').replace(/[\u0000-\u001f\u007f\u00a7]/g, '');
        if (type === 'private') {
            tellPlayer(bot, adminName, clean);
        } else {
            try { bot.chat(clean); } catch (e) {}
        }
    };

    const tellReply = (lines) => {
        if (typeof lines === 'string') lines = [lines];
        tellLines(bot, adminName, lines);
    };

    // 只在私聊中处理代登指令，防止密码泄露
    if (type === 'private') {
        // 代登: /minecraft:tell 79Bot 79Bot 代登 <玩家名> <密码>
        if (/^79Bot\s+代登\s+\S+\s+\S+/.test(cmd)) {
            const match = cmd.match(/^79Bot\s+代登\s+(\S+)\s+(.+)/);
            if (!match) {
                reply('用法: /minecraft:tell 79Bot 79Bot 代登 <玩家名> <密码>');
                return;
            }
            handleProxyLogin(reply, match[1], match[2], adminName);
            return;
        }

        // 代登退出: /minecraft:tell 79Bot 79Bot 代登退出 <玩家名>
        if (/^79Bot\s+代登退出\s+\S+/.test(cmd)) {
            const match = cmd.match(/^79Bot\s+代登退出\s+(\S+)/);
            if (!match) {
                reply('用法: /minecraft:tell 79Bot 79Bot 代登退出 <玩家名>');
                return;
            }
            handleProxyLogout(reply, match[1], adminName);
            return;
        }

        // 代登列表: /minecraft:tell 79Bot 79Bot 代登列表
        if (/^79Bot\s+代登列表/.test(cmd)) {
            handleProxyList(reply);
            return;
        }
    }

    // 公聊指令
    switch (cmd) {
        case '/help':
            tellReply([
                '=== 79Bot 指令 ===',
                '79Bot /help       - 帮助',
                '79Bot Sleep       - 睡觉',
                '79Bot /time       - 游戏时间',
                '79Bot /pos        - 坐标',
                '79Bot /status     - 状态',
                '79Bot /say 内容    - 代发言',
                '79Bot 同意tp      - 接受别人的TPA请求',
                '79Bot 申请tp <玩家> - 向玩家发起TPA请求',
                '79Bot 权限 <玩家> <天数>  - 授权玩家使用Bot',
                '79Bot 权限 撤销 <玩家>    - 撤销玩家使用权限',
                '代登功能请使用私聊: /minecraft:tell 79Bot 79Bot 代登 <玩家> <密码>',
            ]);
            return;
        case '/time': {
            const gameTime = bot.time.timeOfDay;
            const hour = Math.floor((gameTime + 6000) / 1000) % 24;
            const minute = Math.floor(((gameTime + 6000) % 1000) / 1000 * 60);
            reply(`当前游戏时间: ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`);
            return;
        }
        case '/pos': {
            const pos = bot.entity.position;
            reply(`坐标: X=${pos.x.toFixed(1)} Y=${pos.y.toFixed(1)} Z=${pos.z.toFixed(1)}`);
            return;
        }
        case '/status': {
            const hp = bot.health, food = bot.food, pos = bot.entity.position;
            const h = Math.floor((bot.time.timeOfDay + 6000) / 1000) % 24;
            tellReply([
                '=== 79Bot 状态 ===',
                `生命: ${hp}/20  饱食: ${food}/20`,
                `位置: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`,
                `游戏时间: ${h}:00`,
                `代登中: ${proxyBots.size}/${MAX_PROXY_BOTS}`,
            ]);
            return;
        }
        case '同意tp':
        case '同意TP':
        case '同意Tp':
            handleTpAccept(reply, bot);
            return;
        case '代登列表':
            reply('代登相关指令请使用私聊发送，防止密码泄露！');
            reply('用法: /minecraft:tell 79Bot 79Bot 代登列表');
            return;
    }

    // 申请TPA（公聊）
    if (/^申请tpa?\s+/i.test(cmd)) {
        const match = cmd.match(/^申请tpa?\s+(\S+)/i);
        if (!match) {
            reply('用法: 79Bot 申请tp <玩家名>');
            return;
        }
        handleTpaRequest(reply, bot, match[1]);
        return;
    }

    // 权限管理（公聊）
    if (cmd.startsWith('权限 ')) {
        if (!ADMIN_PLAYERS.includes(adminName)) {
            reply('只有管理员才能管理权限');
            return;
        }
        handlePermission(reply, cmd.slice(3).trim(), adminName);
        return;
    }

    if (cmd.toLowerCase() === 'sleep') { handleSleep(reply, bot); return; }

    if (cmd.startsWith('/say ')) {
        const content = cmd.slice(5);
        if (content) try { bot.chat(content.replace(/\u00a7./g, '')); } catch (e) {}
        return;
    }

    reply(`未知指令: ${cmd}`);
}

// ==================== 同意TP ====================
function handleTpAccept(reply, bot) {
    try {
        bot.chat(CMD_PREFIX.tpaccept);
        reply('已发送 /tpaccept，请留意服务器反馈...');
        console.log('[79Bot] 已发送 /tpaccept');
    } catch (e) {
        reply('发送 /tpaccept 失败: ' + e.message);
    }
}

// ==================== 申请TPA ====================
function handleTpaRequest(reply, bot, targetPlayer) {
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(targetPlayer)) {
        reply(`无效的玩家名: ${targetPlayer}`);
        return;
    }
    try {
        const cmd = `${CMD_PREFIX.tpa} ${targetPlayer}`;
        console.log(`[79Bot] 准备发送指令: ${cmd}`);
        bot.chat(cmd);
        reply(`已向 ${targetPlayer} 发送TPA请求，等待对方接受...`);
        console.log(`[79Bot] 已发送: ${cmd}`);
    } catch (e) {
        reply('发送TPA请求失败: ' + e.message);
        console.error('[79Bot TPA错误]', e);
    }
}

// ==================== 代登系统 ====================
function handleProxyLogin(reply, playerName, password, adminName) {
    // 验证玩家名格式
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(playerName)) {
        reply(`无效的玩家名: ${playerName}（只允许字母、数字、下划线，3-16字符）`);
        return;
    }

    // 检查是否已经在代登
    if (proxyBots.has(playerName)) {
        reply(`玩家 ${playerName} 已经在代登中，如需重新登录请先执行 "代登退出 ${playerName}"`);
        return;
    }

    // 检查数量上限
    if (proxyBots.size >= MAX_PROXY_BOTS) {
        reply(`代登数量已达上限（${MAX_PROXY_BOTS}个），请先退出部分代登账号`);
        return;
    }

    // 检查是否与主机器人同名
    if (playerName === CONFIG.username) {
        reply('不能用主机器人的名字代登');
        return;
    }

    reply(`正在为 ${playerName} 创建登录会话...`);
    console.log(`[79Bot 代登] 开始为 ${playerName} 创建登录会话`);

    // 创建代登机器人
    const proxyBot = mineflayer.createBot({
        host: CONFIG.host,
        port: CONFIG.port,
        username: playerName,
        auth: CONFIG.auth,
        version: CONFIG.version,
        keepAlive: true,
        pingInterval: CONFIG.pingInterval,
    });

    let proxyAuthCompleted = false;
    let loginSuccess = false;

    // 登录事件
    proxyBot.on('login', () => {
        console.log(`[79Bot 代登:${playerName}] 已连接服务器，等待认证提示...`);
    });

    // 生成事件
    proxyBot.on('spawn', () => {

        if (!proxyAuthCompleted) {
            console.log(`[79Bot 代登:${playerName}] 已生成但未完成认证，等待服务器提示...`);
            return;
        }
        loginSuccess = true;
        console.log(`[79Bot 代登:${playerName}] 登录成功！`);
        // 登录成功后自动设置皮肤（SkinsRestorer /skin 指令）
        applySkinByName(proxyBot, `[79Bot 代登:${playerName}]`);

        // 通知管理员
        if (currentBot) tellPlayer(currentBot, adminName, `玩家 ${playerName} 已成功登录服务器`);
        safeSay(`${playerName} 已通过79Bot代登上线`);

        // 设置自动超时保护：30分钟无活动自动退出
        const autoLogoutTimer = registerTimer(setTimeout(() => {
            if (proxyBots.has(playerName)) {
                console.log(`[79Bot 代登:${playerName}] 30分钟无活动，自动退出`);
                proxyBot.end();
            }
        }, 30 * 60 * 1000));

        proxyBots.set(playerName, { bot: proxyBot, timer: autoLogoutTimer, admin: adminName });
    });

    // 监听服务器消息，自动注册/登录
    proxyBot.on('message', (jsonMsg) => {
        if (proxyAuthCompleted) return;
        const msgText = jsonMsg.toString();
        console.log(`[79Bot 代登:${playerName}] 服务器消息:`, msgText);

        if (!/\[玩家系统\]/.test(msgText)) return;

        if (/\/register/.test(msgText) || /以注册/.test(msgText)) {
            console.log(`[79Bot 代登:${playerName}] 检测到注册提示，执行 /register`);
            registerTimer(setTimeout(() => {
                try {
                    proxyBot.chat(`/register ${password} ${password}`);
                    console.log(`[79Bot 代登:${playerName}] 已发送注册指令`);
                    proxyAuthCompleted = true;
                } catch (e) {
                    console.error(`[79Bot 代登:${playerName}] 注册失败:`, e.message);
                }
            }, 800));
            return;
        }

        if (/\/login/.test(msgText) || /以登录/.test(msgText)) {
            console.log(`[79Bot 代登:${playerName}] 检测到登录提示，执行 /login`);
            registerTimer(setTimeout(() => {
                try {
                    proxyBot.chat(`/login ${password}`);
                    console.log(`[79Bot 代登:${playerName}] 已发送登录指令`);
                    proxyAuthCompleted = true;
                } catch (e) {
                    console.error(`[79Bot 代登:${playerName}] 登录失败:`, e.message);
                }
            }, 800));
            return;
        }
    });

    // 代登机器人错误处理
    proxyBot.on('error', (err) => {
        console.error(`[79Bot 代登:${playerName}] 错误:`, err.message);
    });

    // 被踢
    proxyBot.on('kicked', (reason) => {
        console.log(`[79Bot 代登:${playerName}] 被踢:`, reason);
        if (currentBot) tellPlayer(currentBot, adminName, `玩家 ${playerName} 被服务器踢出: ${reason}`);
        if (proxyBots.has(playerName)) {
            const info = proxyBots.get(playerName);
            clearTimeout(info.timer);
            proxyBots.delete(playerName);
        }
    });

    // 代登机器人连接断开
    proxyBot.on('end', (reason) => {
        console.log(`[79Bot 代登:${playerName}] 连接断开:`, reason);
        if (proxyBots.has(playerName)) {
            const info = proxyBots.get(playerName);
            clearTimeout(info.timer);
            proxyBots.delete(playerName);
            if (currentBot) {
                tellPlayer(currentBot, info.admin, `玩家 ${playerName} 的代登已断开`);
            }
        }
        if (loginSuccess) {
            safeSay(`${playerName} 已下线`);
        }
    });

    // 连接超时保护：20秒内未完成认证则判定失败
    registerTimer(setTimeout(() => {
        if (!proxyAuthCompleted && !proxyBots.has(playerName)) {
            console.log(`[79Bot 代登:${playerName}] 认证超时，退出连接`);
            try { proxyBot.end(); } catch (e) {}
            if (currentBot) tellPlayer(currentBot, adminName, `玩家 ${playerName} 登录超时，请检查玩家名和密码是否正确`);
        }
    }, 20000));
}

// ==================== 代登退出 ====================
function handleProxyLogout(reply, playerName, adminName) {
    if (!proxyBots.has(playerName)) {
        reply(`玩家 ${playerName} 当前不在代登中`);
        return;
    }

    const info = proxyBots.get(playerName);
    if (info.admin !== adminName && !ADMIN_PLAYERS.includes(adminName)) {
        reply('只有创建该代登会话的管理员或超级管理员才能退出');
        return;
    }

    try {
        info.bot.end();
        clearTimeout(info.timer);
        proxyBots.delete(playerName);
        reply(`已断开 ${playerName} 的代登连接`);
        console.log(`[79Bot 代登] 已手动断开 ${playerName}`);
    } catch (e) {
        reply('断开代登连接失败: ' + e.message);
    }
}

// ==================== 代登列表 ====================
function handleProxyList(reply) {
    if (proxyBots.size === 0) {
        reply('当前没有正在代登的账号');
        return;
    }

    const lines = ['=== 代登列表 ==='];
    for (const [name, info] of proxyBots.entries()) {
        lines.push(`玩家: ${name}  |  管理员: ${info.admin}`);
    }
    lines.push(`共计 ${proxyBots.size}/${MAX_PROXY_BOTS} 个账号`);
    reply(lines.join('\n'));
}

// ==================== 权限管理 ====================
function handlePermission(reply, args, adminName) {
    const parts = args.trim().split(/\s+/);
    if (parts[0] === '撤销') {
        if (parts.length < 2) {
            reply('用法: 79Bot 权限 撤销 <玩家名>');
            return;
        }
        revokePermission(parts[1]);
        reply(`已撤销 ${parts[1]} 的使用权限`);
        return;
    }

    if (parts.length < 2) {
        reply('用法: 79Bot 权限 <玩家名> <天数>');
        return;
    }

    const playerName = parts[0];
    const days = parseInt(parts[1]);
    if (isNaN(days) || days <= 0) {
        reply('天数必须是正整数');
        return;
    }

    grantPermission(playerName, days);
    reply(`已授权 ${playerName} 使用Bot，有效期 ${days} 天`);
}

// ==================== 睡觉 ====================
function handleSleep(reply, bot) {
    const bedBlock = bot.findBlock({
        matching: (block) => {
            return block.name && block.name.includes('bed');
        },
        maxDistance: 6,
    });

    if (!bedBlock) {
        reply('附近6格内没找到床');
        return;
    }

    try {
        bot.sleep(bedBlock);
        reply('正在睡觉...');
    } catch (e) {
        reply('睡觉失败: ' + e.message);
    }
}

// ==================== 启动 ====================
console.log('[79Bot] 正在启动...');
startBot();

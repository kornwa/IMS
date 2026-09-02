// ╔══════════════════════════════════════════════════════════╗
//   ระบบเบิกวัสดุคลัง — Google Apps Script v5.2.4 PATCHED
//   ✅ รวม LINE Messaging API + Discord เป็นชุดเดียว
//   ✅ ไม่มีฟังก์ชันซ้ำ · Token เก็บใน PropertiesService
//   ✅ Settings sheet เก็บ preferences (enabled, notify types)
//
//   📌 v5.2.4 Patches:
//   - แก้ toThaiDateFull() — ตัด GMT+0700 (เวลาอินโดจีน) ออก
//     และรองรับ Date object จาก Google Sheets
//   - แก้ generateRequestPDF() — ใช้ DriveApp.getFileById()
//     อ่านโลโก้จาก Drive โดยตรง แปลงเป็น base64 ฝังใน PDF
//     (แก้ปัญหาโลโก้ไม่ขึ้นเพราะ UrlFetchApp ดึง Drive URL ไม่ได้)
//   - uploadLogoFile() บันทึก logo_file_id ลง Settings ด้วย
//
//   📌 v5.2.5 Patches (แก้ปัญหาแจ้งเตือน LINE เบิ้ล):
//   - submitRequest() ใช้ LockService.getScriptLock() กันสอง
//     คำขอรันพร้อมกัน (race condition) ที่ทำให้สร้างใบเบิกซ้ำ
//   - submitRequest() เช็คใบเบิกซ้ำย้อนหลัง 30 วินาที
//     (ผู้เบิก+หน่วยงาน+วัตถุประสงค์+รายการวัสดุตรงกันหมด)
//     ถ้าซ้ำ → คืนเลขที่ใบเบิกเดิม ไม่สร้างแถวใหม่ ไม่แจ้งเตือนซ้ำ
// ╚══════════════════════════════════════════════════════════╝

const SS_ID  = '1-c70WvbIXk0KsxW8Gy2c1mHEvYUGMIWyc6EGccGIsME';
const ADM_PW = '123456';

// ─── Sheet Names ──────────────────────────────────────────
const SH = {
  ITEMS    : 'Items',
  REQUESTS : 'Requests',
  DETAIL   : 'RequestDetails',
  USERS    : 'Users',
  SETTINGS : 'Settings',
  LOG      : 'StockLog',
  NOTIFY   : 'Notifications',
};

const Q_LABELS = [
  'ไตรมาสที่ 1 (ต.ค.-ธ.ค.)',
  'ไตรมาสที่ 2 (ม.ค.-มี.ค.)',
  'ไตรมาสที่ 3 (เม.ย.-มิ.ย.)',
  'ไตรมาสที่ 4 (ก.ค.-ก.ย.)',
];

const MONTHS_TH = [
  '', 'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
  'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'
];

// ─── Default Branding ─────────────────────────────────────
const DEFAULT_BRANDING = {
  logo_url          : '',
  org_name          : 'ระบบเบิกวัสดุคลัง',
  org_subtitle      : 'Inventory Requisition System',
  org_full_name     : 'ศูนย์พัฒนาเด็กปฐมวัย',
  org_full_subtitle : 'Early Childhood Development Center',
  theme_preset      : 'orange',
  theme_primary     : '#e85d04',
  theme_primary_dark: '#c94d00',
  theme_primary_light:'#ff6b1a',
};

const THEME_PRESETS = {
  orange: { primary:'#e85d04', dark:'#c94d00', light:'#ff6b1a' },
  blue  : { primary:'#2563eb', dark:'#1d4ed8', light:'#3b82f6' },
  green : { primary:'#16a34a', dark:'#15803d', light:'#22c55e' },
  purple: { primary:'#7e22ce', dark:'#6b21a8', light:'#9333ea' },
  red   : { primary:'#dc2626', dark:'#b91c1c', light:'#ef4444' },
  teal  : { primary:'#0891b2', dark:'#0e7490', light:'#06b6d4' },
  pink  : { primary:'#db2777', dark:'#be185d', light:'#ec4899' },
};
// ─── Cartoon URLs ─────────────────────────────────────────
const CARTOON = {
  NEW_REQUEST : 'https://drive.google.com/thumbnail?id=1XTMjvDYaDlupgN-D6k7h7xJXMQv5K45N&sz=w400',
  APPROVE     : 'https://drive.google.com/thumbnail?id=1pyxI-YIGEE90BKjyu7DK6Rn_rzsbe3Kr&sz=w400', 
  REJECT      : 'https://drive.google.com/thumbnail?id=1lOLn1gu9S7yW2qbcD-Tb8xkV6DLQOkuZ&sz=w400',
  LOW_STOCK   : 'https://drive.google.com/thumbnail?id=1pyxI-YIGEE90BKjyu7DK6Rn_rzsbe3Kr&sz=w400',
};
// ══════════════════════════════════════════════════════════
//  ENTRY POINTS
// ══════════════════════════════════════════════════════════

function doGet(e) {
  e = e || { parameter: {} };
  const page = String(e.parameter.page || 'user').toLowerCase();
  if (page === 'linewebhook') return ContentService.createTextOutput('OK');
  const file = page === 'admin' ? 'Admin' : 'Index';
  const template = HtmlService.createTemplateFromFile(file);
  return template.evaluate()
    .setSandboxMode(HtmlService.SandboxMode.IFRAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no')
    .setTitle(page === 'admin' ? '⚙️ Admin — ระบบเบิกวัสดุ' : '🏛️ ระบบเบิกวัสดุคลัง')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return ContentService.createTextOutput('OK');
    const body = JSON.parse(e.postData.contents);
    if (body.fn) return _apiDispatch(body);
    const events = body.events || [];
    events.forEach(ev => {
      const userId  = ev.source && ev.source.userId;
      const msgText = ev.message && ev.message.text ? String(ev.message.text).trim() : '';
      if (!userId) return;

      if (msgText.startsWith('ลงทะเบียน')) {
        const parts = msgText.split(/\s+/);
        const name  = parts[1] || '';
        const dept  = parts.slice(2).join(' ') || '';
        if (name && dept) {
          const saved = saveUserLineId(name, dept, userId);
          replyLineMessage(ev.replyToken, saved
            ? '✅ ลงทะเบียนสำเร็จ!\nชื่อ: ' + name + '\nหน่วยงาน: ' + dept + '\nท่านจะได้รับแจ้งเตือนเมื่อมีการอนุมัติ/ปฏิเสธใบเบิกของท่าน'
            : '⚠️ ไม่พบ "' + name + '" ในหน่วยงาน "' + dept + '"\n\nกรุณาเข้าสู่ระบบและยื่นใบเบิกผ่านเว็บอย่างน้อย 1 ครั้งก่อน แล้วกลับมาพิมพ์คำสั่งนี้ใหม่');
        } else {
          replyLineMessage(ev.replyToken, '📝 รูปแบบคำสั่ง:\nลงทะเบียน [ชื่อ] [หน่วยงาน]\n\nตัวอย่าง:\nลงทะเบียน สมใจ ฝ่ายการเงิน');
        }
        return;
      }

      if (msgText === 'สถานะ' || msgText === 'ของฉัน') {
        replyLineMessage(ev.replyToken, buildUserStatusReply(userId));
        return;
      }
if (
  msgText === 'ของใกล้หมด' ||
  msgText === 'ขอดูของใกล้หมด' ||
  msgText === 'วัสดุใกล้หมด' ||
  msgText === 'ดูของใกล้หมด' ||
  msgText === 'สต็อก' ||
  msgText === 'stock' ||
  msgText.includes('ใกล้หมด')
) {
  try {
    const low = rows(SH.ITEMS).filter(
      x => Number(x.qty) <= Number(x.minQty) && Number(x.qty) >= 0
    );
    if (!low.length) {
      replyLineMessage(
        ev.replyToken,
        '✅ ขณะนี้ไม่มีวัสดุใกล้หมด\nสต็อกทุกรายการอยู่ในเกณฑ์ปกติ 🎉'
      );
    } else {
      const lowMapped = low.map(it => ({
        name  : it.name,
        qty   : Number(it.qty),
        minQty: Number(it.minQty),
        unit  : it.unit || ''
      }));
      replyLineMessage(ev.replyToken, buildFlexLowStock(lowMapped));
    }
  } catch(e) {
    Logger.log('ของใกล้หมด error: ' + e.message);
    replyLineMessage(ev.replyToken, '⚠️ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง');
  }
  return;
}

      if (msgText === 'ID' || msgText === 'id' || msgText.toLowerCase() === 'my id') {
        const srcType = ev.source && ev.source.type;
        let reply = '🆔 LINE User ID ของคุณ:\n' + userId;
        if (srcType === 'group' && ev.source.groupId) {
          reply += '\n\n👥 Group ID ของกลุ่มนี้:\n' + ev.source.groupId +
                   '\n(นำไปวางในช่อง "LINE User ID / Group ID ของแอดมิน" ที่ Admin Panel เพื่อให้ผลอนุมัติ/ปฏิเสธประกาศเข้ากลุ่มนี้)';
        } else if (srcType === 'room' && ev.source.roomId) {
          reply += '\n\n👥 Room ID:\n' + ev.source.roomId;
        }
        reply += '\n\n(สำหรับ Admin คัดลอกไปตั้งค่าระบบ)';
        replyLineMessage(ev.replyToken, reply);
        return;
      }

      if (ev.type === 'follow') {
        replyLineMessage(ev.replyToken,
          '🏛️ ยินดีต้อนรับสู่ระบบเบิกวัสดุคลัง!\n\n' +
          '📌 คำสั่งที่ใช้ได้:\n' +
          '• ลงทะเบียน [ชื่อ] [หน่วยงาน]\n' +
          '• สถานะ — ดูใบเบิกล่าสุด\n' +
          '• ของใกล้หมด — ดูวัสดุที่ต้องเติม\n' +
          '• ID — ดู LINE User ID ของท่าน\n\n' +
          '💡 ตัวอย่าง:\nลงทะเบียน สมใจ ฝ่ายการเงิน'
        );
      }
    });
  } catch(err) {
    Logger.log('Webhook error: ' + err.message);
  }
  return ContentService.createTextOutput('OK');
}

function _apiDispatch(body) {
  const API = {
    loginAdmin, loginUser, initSheets,
    getPublicSettings, getBranding, saveBranding, getBrandingSettings, saveBrandingSettings, resetBrandingDefaults, uploadLogoFile, removeLogo,
    getItems, addItem, updateItem, deleteItem, adjustStock, getStockLog, exportItemsCSV, exportRequestsCSV,
    getRequests, getMyRequests, getRequestDetails, submitRequest, approveRequest, approveRequestItems, bulkApproveRequests, rejectRequest, cancelRequest, generateRequestPDF, adminSubmitRequest, diagnoseRequestNotify,
    getUsers, getUserNames, updateUserEmail, toggleUser, deleteUser, updateUserActivity, saveUserLineId, updateUserLineId,
    getSettings, saveSetting, getLineToken, saveLineToken, testLineNotify, validateLineToken, getWebhookUrl,
    getStatistics, getAvailableFiscalYears, getScriptUrl, forceResetAdminPassword,
  };
  const fn = API[body.fn];
  if (!fn) return ContentService.createTextOutput(JSON.stringify({ error: 'ไม่อนุญาต: ' + body.fn })).setMimeType(ContentService.MimeType.JSON);
  try {
    const args = Array.isArray(body.args) ? body.args : (body.args !== undefined ? [body.args] : []);
    const result = fn(...args);
    const text = (result === undefined || result === null) ? 'null' : (typeof result === 'string' ? result : JSON.stringify(result));
    return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.message, checks: [], success: false })).setMimeType(ContentService.MimeType.JSON);
  }
}

function buildUserStatusReply(lineUserId) {
  const users = rows(SH.USERS);
  const user = users.find(u => String(u.lineUserId || '').trim() === String(lineUserId).trim());
  if (!user) return '⚠️ ท่านยังไม่ได้ลงทะเบียน\n\nพิมพ์: ลงทะเบียน [ชื่อ] [หน่วยงาน]';
  const reqs = rows(SH.REQUESTS).filter(r => r.requesterName === user.name && r.department === user.department);
  if (!reqs.length) return '📋 ' + user.name + '\nยังไม่มีใบเบิกในระบบ';
  const recent = reqs.slice(-5).reverse();
  const lines = recent.map(r => '• ' + r.requestId + '\n  ' + r.status + ' · ' + (r.requestDate || '–'));
  return '📋 ใบเบิกล่าสุดของท่าน\n━━━━━━━━━━━━━━━━━\n👤 ' + user.name + ' (' + user.department + ')\n\n' + lines.join('\n\n');
}

function getScriptUrl() {
  try { return ScriptApp.getService().getUrl(); } catch(e) { return ''; }
}

// ══════════════════════════════════════════════════════════
//  📢 LINE Messaging API + Discord Webhook
// ══════════════════════════════════════════════════════════

const LINE_API = {
  PUSH      : 'https://api.line.me/v2/bot/message/push',
  REPLY     : 'https://api.line.me/v2/bot/message/reply',
  MULTICAST : 'https://api.line.me/v2/bot/message/multicast',
  BROADCAST : 'https://api.line.me/v2/bot/message/broadcast',
  BOT_INFO  : 'https://api.line.me/v2/bot/info',
};

function _getLineChannelToken(override) {
  const t = String(override || '').trim();
  if (t) return t;
  const fromProps = String(PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_TOKEN') || '').trim();
  if (fromProps) return fromProps;
  return String(getSettingValue('line_channel_token', '')).trim();
}

function _getDiscordWebhookUrl() {
  const fromProps = String(PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK') || '').trim();
  if (fromProps) return fromProps;
  return String(getSettingValue('discord_webhook', '')).trim();
}

function _getAdminLineUserIds() {
  const raw = getSettingValue('line_admin_user_ids', '');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map(x => String(x).trim()).filter(x => /^[UCR]/.test(x));
  } catch (e) {}
  return String(raw).split(/[,;\n\r]+/).map(x => x.trim()).filter(x => /^[UCR]/.test(x));
}

function isLineEnabled() {
  return String(getSettingValue('line_notify_enabled', 'true')) !== 'false';
}

function _shouldNotify(type) {
  if (!isLineEnabled()) return false;
  const key = { new: 'line_notify_new', approve: 'line_notify_approve', reject: 'line_notify_reject', low_stock: 'line_notify_low_stock' }[type];
  if (!key) return true;
  return String(getSettingValue(key, 'true')) !== 'false';
}

function _toLineMsg(message) {
  if (typeof message === 'string') return { type: 'text', text: String(message).slice(0, 4900) };
  return message;
}

function _callLineApi(url, payload, tokenOverride) {
  const token = _getLineChannelToken(tokenOverride);
  if (!token) return { success: false, code: 0, error: 'ไม่พบ Channel Access Token', message: 'ไม่พบ Channel Access Token', body: '' };
  try {
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    const body = res.getContentText();
    Logger.log('LINE API [' + url.split('/').pop() + '] Code: ' + code);
    if (code >= 200 && code < 300) return { success: true, code, body, message: 'ส่งสำเร็จ' };
    let error = 'ส่งไม่สำเร็จ (HTTP ' + code + ')';
    if (code === 400) error = 'รูปแบบข้อความหรือ User ID ไม่ถูกต้อง';
    if (code === 401) error = 'Token ไม่ถูกต้อง/หมดอายุ — กรุณา Issue Token ใหม่';
    if (code === 403) error = 'ไม่มีสิทธิ์ส่ง หรือผู้รับยังไม่ Add เพื่อน LINE OA';
    if (code === 429) error = 'เกินโควตา LINE Messaging API';
    return { success: false, code, error, message: error, body };
  } catch (err) {
    return { success: false, code: 0, error: err.message, message: err.message, body: '' };
  }
}

function _sendDiscord(message) {
  const url = _getDiscordWebhookUrl();
  if (!url) return false;
  try {
    let textMsg;
    if (typeof message === 'string') {
      textMsg = message.slice(0, 1900);
    } else if (message && message.altText) {
      textMsg = String(message.altText).slice(0, 1900);
    } else {
      textMsg = '📢 แจ้งเตือนจากระบบ';
    }
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({
        content: textMsg,
        username: 'ระบบเบิกวัสดุ'
      }),
      muteHttpExceptions: true
    });
    return res.getResponseCode() >= 200 && res.getResponseCode() < 300;
  } catch(e) {
    Logger.log('_sendDiscord error: ' + e.message);
    return false;
  }
}

function pushLineMessage(userId, message, tokenOverride) {
  if (!isLineEnabled() && !tokenOverride) return { success: false, code: 0, error: 'LINE ปิดอยู่', message: 'LINE ปิดอยู่' };
  const uid = String(userId || '').trim();
  if (!uid) return { success: false, code: 0, error: 'ไม่พบ User/Group ID', message: 'ไม่พบ User/Group ID' };
  if (!/^[UCR]/.test(uid)) return { success: false, code: 0, error: 'ID ต้องขึ้นต้นด้วย U (ผู้ใช้) หรือ C (กลุ่ม)', message: 'ID ต้องขึ้นต้นด้วย U หรือ C' };
  return _callLineApi(LINE_API.PUSH, { to: uid, messages: [_toLineMsg(message)] }, tokenOverride);
}

function replyLineMessage(replyToken, message, tokenOverride) {
  const rt = String(replyToken || '').trim();
  if (!rt) return { success: false, code: 0, error: 'ไม่พบ replyToken', message: 'ไม่พบ replyToken' };
  return _callLineApi(LINE_API.REPLY, { replyToken: rt, messages: [_toLineMsg(message)] }, tokenOverride);
}

function pushToAdmins(message, tokenOverride) {
  if (!isLineEnabled() && !tokenOverride) { Logger.log('LINE Notify Disabled'); return false; }
  let lineSuccess = false;
  let discordSuccess = false;

  const lineToken = _getLineChannelToken(tokenOverride);
  if (lineToken) {
    const ids = _getAdminLineUserIds();
    if (ids.length > 0) {
      // ส่งทีละ ID (รองรับทั้ง User ID ส่วนตัว และ Group ID ของกลุ่ม LINE รวม —
      // LINE Multicast API ไม่รองรับ Group ID เลยส่งทีละรายการแทนเพื่อความชัวร์)
      ids.forEach(id => {
        const r = pushLineMessage(id, message, tokenOverride);
        if (r && r.success) lineSuccess = true;
        else Logger.log('[pushToAdmins] ส่งหา ' + id + ' ไม่สำเร็จ: ' + (r && (r.error || r.message)));
      });
    } else {
      lineSuccess = _callLineApi(LINE_API.BROADCAST, { messages: [_toLineMsg(message)] }, tokenOverride).success;
    }
  }

  if (_getDiscordWebhookUrl()) {
    discordSuccess = _sendDiscord(message);
  }

  return lineSuccess || discordSuccess;
}

// ══════════════════════════════════════════════════════════
//  LINE Settings API
// ══════════════════════════════════════════════════════════

function getLineSettings() {
  initSheets();
  const rawToken = String(PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_TOKEN') || '').trim()
    || String(getSettingValue('line_channel_token', '')).trim();
  const discordUrl = String(PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK') || '').trim()
    || String(getSettingValue('discord_webhook', '')).trim();

  const maskedToken = rawToken ? rawToken.slice(0, 8) + '...' + rawToken.slice(-4) : '';
  const maskedDiscord = discordUrl ? discordUrl.slice(0, 38) + '...' : '';

  return JSON.stringify({
    token          : maskedToken,
    discordWebhook : maskedDiscord,
    adminUserIds   : getSettingValue('line_admin_user_ids', ''),
    enabled        : String(getSettingValue('line_notify_enabled', 'true')) !== 'false',
    notifyNew      : String(getSettingValue('line_notify_new', 'true')) !== 'false',
    notifyApprove  : String(getSettingValue('line_notify_approve', 'true')) !== 'false',
    notifyReject   : String(getSettingValue('line_notify_reject', 'true')) !== 'false',
    notifyLowStock : String(getSettingValue('line_notify_low_stock', 'true')) !== 'false',
    hasLineToken   : rawToken.length > 0,
    hasDiscord     : discordUrl.length > 0,
  });
}

function saveLineSettings(json) {
  try {
    initSheets();
    const data = JSON.parse(json || '{}');
    const props = PropertiesService.getScriptProperties();

    const t = String(data.token || '').trim();

    if (t !== '__SKIP__') {
      if (t) props.setProperty('LINE_CHANNEL_TOKEN', t);
      else props.deleteProperty('LINE_CHANNEL_TOKEN');
    }

    const dw = String(data.discordWebhook || '').trim();
    if (dw !== '__SKIP__') {
      if (dw) props.setProperty('DISCORD_WEBHOOK', dw);
      else props.deleteProperty('DISCORD_WEBHOOK');
    }

    if (data.adminUserIds !== undefined) {
      const adminIds = String(data.adminUserIds || '').split(/[,;\n\r]+/).map(x => x.trim()).filter(Boolean).join(',');
      saveSettingValue('line_admin_user_ids', adminIds);
    }
    if (data.enabled !== undefined)        saveSettingValue('line_notify_enabled',   String(data.enabled !== false));
    if (data.notifyNew !== undefined)      saveSettingValue('line_notify_new',       String(data.notifyNew !== false));
    if (data.notifyApprove !== undefined)  saveSettingValue('line_notify_approve',   String(data.notifyApprove !== false));
    if (data.notifyReject !== undefined)   saveSettingValue('line_notify_reject',    String(data.notifyReject !== false));
    if (data.notifyLowStock !== undefined) saveSettingValue('line_notify_low_stock', String(data.notifyLowStock !== false));

    return JSON.stringify({ success: true, message: 'บันทึก LINE Settings สำเร็จ' });
  } catch (err) {
    return JSON.stringify({ success: false, error: err.message });
  }
}

function saveLineToken(params) {
  try {
    const t = String((params && params.token) || '').trim();
    const props = PropertiesService.getScriptProperties();

    if (!t) {
      props.deleteProperty('LINE_CHANNEL_TOKEN');
      props.deleteProperty('DISCORD_WEBHOOK');
      return { success: true, message: '🗑️ ล้างค่าแจ้งเตือนทั้งหมดแล้ว' };
    }

    if (t.startsWith('https://discord.com/api/webhooks/') || t.startsWith('https://discordapp.com/api/webhooks/')) {
      props.setProperty('DISCORD_WEBHOOK', t);
      return { success: true, message: '✅ บันทึก Discord Webhook สำเร็จ' };
    }

    if (t.length > 100) {
      props.setProperty('LINE_CHANNEL_TOKEN', t);
      return { success: true, message: '✅ บันทึก LINE Channel Access Token สำเร็จ' };
    }

    props.setProperty('LINE_CHANNEL_TOKEN', t);
    return { success: true, message: '⚠️ บันทึกแล้ว แต่ Token ดูสั้นไป — ตรวจสอบว่าเป็น Channel Access Token (long-lived)' };
  } catch(e) {
    return { success: false, message: e.message };
  }
}

function getLineToken() {
  const lt = String(PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_TOKEN') || '').trim();
  const dw = String(PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK') || '').trim();
  return {
    line    : lt ? lt.slice(0, 8) + '...' + lt.slice(-4) : '',
    discord : dw ? '✅ ตั้งค่าแล้ว' : '',
    hasAny  : !!(lt || dw),
  };
}

function validateLineToken(token) {
  const t = String(token || _getLineChannelToken()).trim();
  if (!t || t.length < 50) return JSON.stringify({ success: false, error: 'Token สั้นเกินไป (ต้องยาวกว่า 50 ตัวอักษร)' });
  try {
    const res = UrlFetchApp.fetch(LINE_API.BOT_INFO, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + t },
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    const body = JSON.parse(res.getContentText());
    if (code === 200) return JSON.stringify({ success: true, botName: body.displayName || '', botId: body.userId || '', pictureUrl: body.pictureUrl || '' });
    return JSON.stringify({ success: false, error: body.message || 'HTTP ' + code, code });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

function testLinePush(json) {
  try {
    initSheets();
    const data = typeof json === 'string' ? JSON.parse(json) : (json || {});
    const tokenOverride = String(data.token || '').trim();
    const userId        = String(data.userId || _getAdminLineUserIds()[0] || '').trim();

    if (!userId) return JSON.stringify({ success: false, code: 0, error: 'ไม่พบ Admin LINE User ID — กรุณากรอก User ID ก่อน', message: 'ไม่พบ User ID' });
    if (!userId.startsWith('U')) return JSON.stringify({ success: false, code: 0, error: 'LINE User ID ต้องขึ้นต้นด้วย U', message: 'User ID ไม่ถูกต้อง' });

    const branding = getBrandingObject();
    const flexMsg = {
      type: 'flex',
      altText: '🔔 ทดสอบระบบแจ้งเตือน',
      contents: {
        type: 'bubble', size: 'kilo',
        header: {
          type: 'box', layout: 'vertical',
          backgroundColor: branding.theme_primary_dark || '#c94d00', paddingAll: '14px',
          contents: [{ type: 'text', text: '🔔 ทดสอบระบบแจ้งเตือน', color: '#ffffff', weight: 'bold', size: 'md' }]
        },
        body: {
          type: 'box', layout: 'vertical', paddingAll: '16px',
          contents: [
            { type: 'text', text: '✅ เชื่อมต่อ LINE สำเร็จ!', weight: 'bold', size: 'md', color: '#16a34a' },
            { type: 'text', text: branding.org_name || 'ระบบเบิกวัสดุคลัง', size: 'sm', color: '#666666', margin: 'md', wrap: true },
            { type: 'separator', margin: 'lg' },
            { type: 'text', text: '📅 ' + nowThai(), size: 'xs', color: '#999999', margin: 'md' }
          ]
        }
      }
    };

    const result = pushLineMessage(userId, flexMsg, tokenOverride || undefined);
    if (result.success) {
      return JSON.stringify({ success: true, code: result.code, message: 'ส่งทดสอบสำเร็จ! ตรวจสอบ LINE ของท่าน', body: result.body || '' });
    }
    return JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({ success: false, code: 0, error: err.message, message: err.message });
  }
}

function testLineNotify(params) {
  const message = (params && params.message)
    ? params.message
    : '✅ ทดสอบการแจ้งเตือน\n📅 ' + nowThai();

  const lineToken  = String(PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_TOKEN') || '').trim();
  const discordUrl = String(PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK') || '').trim();

  if (!lineToken && !discordUrl) {
    return { success: false, message: '⚠️ ยังไม่ได้ตั้งค่าช่องทางแจ้งเตือน' };
  }

  const results = [];
  if (lineToken) {
    const res = _callLineApi(LINE_API.BROADCAST, { messages: [{ type: 'text', text: message }] });
    results.push(res.success ? '✅ LINE ส่งสำเร็จ' : '❌ LINE ล้มเหลว: ' + res.error);
  }
  if (discordUrl) {
    results.push(_sendDiscord(message) ? '✅ Discord ส่งสำเร็จ' : '❌ Discord ล้มเหลว');
  }

  const allOk = !results.some(r => r.startsWith('❌'));
  return { success: allOk, message: results.join(' | ') };
}

function getWebhookUrl() {
  try { return JSON.stringify({ url: ScriptApp.getService().getUrl() || '' }); }
  catch (e) { return JSON.stringify({ url: '', error: e.message }); }
}

// ══════════════════════════════════════════════════════════
//  LINE Flex Message Builders
// ══════════════════════════════════════════════════════════

function buildFlexNewRequest(req, dets) {
  const branding = getBrandingObject();
  const items = (dets || []).slice(0, 6);
  const hasMore = (dets || []).length > 6;
 
  const itemBoxes = items.map((d, i) => ({
    type: 'box', layout: 'horizontal', spacing: 'sm',
    contents: [
      { type: 'text', text: String(i + 1) + '.', size: 'xs', color: '#999999', flex: 1 },
      { type: 'text', text: String(d.itemName || ''), size: 'sm', color: '#333333', flex: 6, wrap: true },
      { type: 'text', text: String(d.qtyRequested || 0) + ' ' + String(d.unit || ''), size: 'xs', color: '#666666', flex: 3, align: 'end' },
    ],
  }));
  if (hasMore) {
    itemBoxes.push({
      type: 'text',
      text: '… และอีก ' + ((dets || []).length - 6) + ' รายการ',
      size: 'xs', color: '#999999', align: 'center', margin: 'sm',
    });
  }
 
  return {
    type: 'flex',
    altText: '📦 ใบเบิกวัสดุใหม่: ' + req.requestId,
    contents: {
      type: 'bubble', size: 'mega',
 
      // ── Header พร้อมรูปการ์ตูน (position: absolute) ──
      header: {
  type: 'box', layout: 'horizontal',
  backgroundColor: branding.theme_primary_dark || '#c94d00',
  paddingAll: 'lg',
  contents: [
    {
      type: 'box', layout: 'vertical', flex: 4, justifyContent: 'center',
      contents: [
        { type: 'text', text: '📦 ใบเบิกวัสดุใหม่', color: '#ffffff', weight: 'bold', size: 'lg' },
        { type: 'text', text: req.requestId, color: '#ffffffcc', size: 'xs', margin: 'xs' },
      ],
    },
    {
      type: 'image',
      url: CARTOON.NEW_REQUEST,
      flex: 2,
      size: 'sm',
      aspectMode: 'fit',
      aspectRatio: '1:1',
    },
  ],
},
 
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          {
            type: 'box', layout: 'vertical', spacing: 'sm',
            contents: [
              { type: 'box', layout: 'baseline', contents: [{ type: 'text', text: '👤 ผู้เบิก', size: 'xs', color: '#999999', flex: 3 }, { type: 'text', text: String(req.requesterName || '–'), size: 'sm', color: '#333333', flex: 7, weight: 'bold' }] },
              { type: 'box', layout: 'baseline', contents: [{ type: 'text', text: '🏢 หน่วยงาน', size: 'xs', color: '#999999', flex: 3 }, { type: 'text', text: String(req.department || '–'), size: 'sm', color: '#333333', flex: 7 }] },
              { type: 'box', layout: 'baseline', contents: [{ type: 'text', text: '🎯 วัตถุประสงค์', size: 'xs', color: '#999999', flex: 3 }, { type: 'text', text: String(req.purpose || '–'), size: 'sm', color: '#333333', flex: 7, wrap: true }] },
              { type: 'box', layout: 'baseline', contents: [{ type: 'text', text: '📅 วันที่', size: 'xs', color: '#999999', flex: 3 }, { type: 'text', text: String(req.requestDate || '–'), size: 'sm', color: '#333333', flex: 7 }] },
            ],
          },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '🧾 รายการที่ขอเบิก (' + ((dets || []).length || 0) + ' รายการ)', weight: 'bold', size: 'sm', color: '#555555' },
          { type: 'box', layout: 'vertical', spacing: 'xs', contents: itemBoxes },
        ],
      },
 
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: '⏳ รอการอนุมัติจาก Admin', size: 'xs', color: '#999999', align: 'center' },
        ],
      },
    },
  };
}

function buildFlexStatusUpdate(req, dets, status, detail) {
  const branding = getBrandingObject();
  const colorMap = {
    'อนุมัติ'        : { bg: '#16a34a', emoji: '✅', label: 'อนุมัติแล้ว',     cartoon: CARTOON.APPROVE },
    'อนุมัติบางส่วน' : { bg: '#d97706', emoji: '⚠️', label: 'อนุมัติบางส่วน', cartoon: CARTOON.APPROVE },
    'ปฏิเสธ'         : { bg: '#dc2626', emoji: '❌', label: 'ปฏิเสธ',          cartoon: CARTOON.REJECT  },
    'ยกเลิก'         : { bg: '#6b7280', emoji: '🚫', label: 'ยกเลิก',          cartoon: CARTOON.REJECT  },
  };
  const c = colorMap[status] || { bg: '#3b82f6', emoji: '📋', label: status, cartoon: CARTOON.APPROVE };
  const totalReq = (dets || []).reduce((s, d) => s + Number(d.qtyRequested), 0);
  const totalApp = (dets || []).reduce((s, d) => s + Number(d.qtyApproved || 0), 0);
 
  const bodyContents = [
    { type: 'box', layout: 'baseline', contents: [{ type: 'text', text: '📋 เลขที่', size: 'xs', color: '#999999', flex: 3 }, { type: 'text', text: String(req.requestId), size: 'sm', color: '#333333', flex: 7, weight: 'bold' }] },
    { type: 'box', layout: 'baseline', contents: [{ type: 'text', text: '📅 วันที่เบิก', size: 'xs', color: '#999999', flex: 3 }, { type: 'text', text: String(req.requestDate || '–'), size: 'sm', color: '#333333', flex: 7 }] },
    { type: 'box', layout: 'baseline', contents: [{ type: 'text', text: '🎯 วัตถุประสงค์', size: 'xs', color: '#999999', flex: 3 }, { type: 'text', text: String(req.purpose || '–'), size: 'sm', color: '#333333', flex: 7, wrap: true }] },
  ];
 
  if (status === 'อนุมัติ' || status === 'อนุมัติบางส่วน') {
    bodyContents.push({ type: 'separator', margin: 'md' });
    bodyContents.push({ type: 'box', layout: 'baseline', contents: [{ type: 'text', text: '📦 รายการ', size: 'xs', color: '#999999', flex: 3 }, { type: 'text', text: (dets || []).length + ' รายการ', size: 'sm', color: '#333333', flex: 7, weight: 'bold' }] });
    bodyContents.push({ type: 'box', layout: 'baseline', contents: [{ type: 'text', text: '🔢 จำนวน', size: 'xs', color: '#999999', flex: 3 }, { type: 'text', text: 'ขอ ' + totalReq + ' · อนุมัติ ' + totalApp + ' หน่วย', size: 'sm', color: '#333333', flex: 7 }] });
    if (req.approvedBy) bodyContents.push({ type: 'box', layout: 'baseline', contents: [{ type: 'text', text: '✍️ ผู้อนุมัติ', size: 'xs', color: '#999999', flex: 3 }, { type: 'text', text: String(req.approvedBy), size: 'sm', color: '#333333', flex: 7 }] });
  }
 
  if (detail && (status === 'ปฏิเสธ' || status === 'อนุมัติบางส่วน')) {
    bodyContents.push({ type: 'separator', margin: 'md' });
    bodyContents.push({
      type: 'box', layout: 'vertical', spacing: 'xs',
      backgroundColor: status === 'ปฏิเสธ' ? '#fef2f2' : '#fffbeb',
      paddingAll: 'sm', cornerRadius: '4px',
      contents: [
        { type: 'text', text: status === 'ปฏิเสธ' ? '❌ เหตุผล' : '⚠️ หมายเหตุ', size: 'xs', color: '#666666', weight: 'bold' },
        { type: 'text', text: String(detail).substring(0, 200), size: 'xs', color: '#555555', wrap: true, margin: 'xs' },
      ],
    });
  }
 
  return {
    type: 'flex',
    altText: c.emoji + ' ใบเบิก ' + req.requestId + ' — ' + c.label,
    contents: {
      type: 'bubble', size: 'mega',
 
      // ── Header พร้อมการ์ตูนตามสถานะ ──
      header: {
  type: 'box', layout: 'horizontal',
  backgroundColor: c.bg, paddingAll: 'lg',
  contents: [
    {
      type: 'box', layout: 'vertical', flex: 4, justifyContent: 'center',
      contents: [
        { type: 'text', text: c.emoji + ' ' + c.label, color: '#ffffff', weight: 'bold', size: 'xl' },
        { type: 'text', text: 'ผลใบเบิกวัสดุของท่าน', color: '#ffffffcc', size: 'xs', margin: 'xs' },
      ],
    },
    {
      type: 'image',
      url: c.cartoon,
      flex: 2,
      size: 'sm',
      aspectMode: 'fit',
      aspectRatio: '1:1',
    },
  ],
},
 
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: bodyContents },
 
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: branding.org_name || 'ระบบเบิกวัสดุคลัง', size: 'xs', color: '#999999', align: 'center' },
        ],
      },
    },
  };
}
function buildFlexAdminStatusUpdate(req, dets, status, detail) {
  const branding = getBrandingObject();
  const colorMap = {
    'อนุมัติ'        : { bg: '#16a34a', bgLight: '#dcfce7', emoji: '✅', label: 'อนุมัติแล้ว',     sublabel: 'ใบเบิกได้รับการอนุมัติเรียบร้อย' },
    'อนุมัติบางส่วน' : { bg: '#d97706', bgLight: '#fef3c7', emoji: '⚠️', label: 'อนุมัติบางส่วน', sublabel: 'บางรายการสต็อกไม่เพียงพอ' },
    'ปฏิเสธ'         : { bg: '#dc2626', bgLight: '#fee2e2', emoji: '❌', label: 'ปฏิเสธ',          sublabel: 'ใบเบิกถูกปฏิเสธ' },
    'ยกเลิก'         : { bg: '#6b7280', bgLight: '#f3f4f6', emoji: '🚫', label: 'ยกเลิก',          sublabel: 'ใบเบิกถูกยกเลิก' },
  };
  const c = colorMap[status] || { bg: '#3b82f6', bgLight: '#dbeafe', emoji: '📋', label: status, sublabel: 'อัปเดตสถานะใบเบิก' };
  const totalReq = (dets || []).reduce((s, d) => s + Number(d.qtyRequested), 0);
  const totalApp = (dets || []).reduce((s, d) => s + Number(d.qtyApproved || 0), 0);

  const items = (dets || []).slice(0, 4);
  const hasMore = (dets || []).length > 4;
  const itemBoxes = items.map((d, i) => ({
    type: 'box', layout: 'horizontal', spacing: 'sm',
    contents: [
      { type: 'text', text: String(i + 1) + '.', size: 'xs', color: '#999999', flex: 1 },
      { type: 'text', text: String(d.itemName || ''), size: 'sm', color: '#333333', flex: 6, wrap: true },
      { type: 'text', text: String(d.qtyRequested || 0) + ' ' + String(d.unit || ''), size: 'xs', color: '#666666', flex: 3, align: 'end' },
    ],
  }));
  if (hasMore) {
    itemBoxes.push({ type: 'text', text: '… และอีก ' + ((dets || []).length - 4) + ' รายการ', size: 'xs', color: '#999999', align: 'center', margin: 'sm' });
  }

  const bodyContents = [
    { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'box', layout: 'baseline', contents: [
        { type: 'text', text: '👤 ผู้เบิก', size: 'xs', color: '#999999', flex: 3 },
        { type: 'text', text: String(req.requesterName || '–'), size: 'sm', color: '#333333', flex: 7, weight: 'bold' }
      ]},
      { type: 'box', layout: 'baseline', contents: [
        { type: 'text', text: '🏢 หน่วยงาน', size: 'xs', color: '#999999', flex: 3 },
        { type: 'text', text: String(req.department || '–'), size: 'sm', color: '#333333', flex: 7 }
      ]},
      { type: 'box', layout: 'baseline', contents: [
        { type: 'text', text: '🎯 วัตถุประสงค์', size: 'xs', color: '#999999', flex: 3 },
        { type: 'text', text: String(req.purpose || '–'), size: 'sm', color: '#333333', flex: 7, wrap: true }
      ]},
      { type: 'box', layout: 'baseline', contents: [
        { type: 'text', text: '📅 วันที่เบิก', size: 'xs', color: '#999999', flex: 3 },
        { type: 'text', text: String(req.requestDate || '–'), size: 'sm', color: '#333333', flex: 7 }
      ]},
    ]},
    { type: 'separator', margin: 'md' },
  ];

  if (status === 'อนุมัติ' || status === 'อนุมัติบางส่วน') {
    bodyContents.push({ type: 'box', layout: 'horizontal', spacing: 'md', margin: 'md', contents: [
      { type: 'box', layout: 'vertical', flex: 1, spacing: 'xs', backgroundColor: '#f0fdf4', paddingAll: 'sm', cornerRadius: '6px', contents: [
        { type: 'text', text: '📦 รายการ', size: 'xxs', color: '#999999', align: 'center' },
        { type: 'text', text: String((dets || []).length), size: 'lg', weight: 'bold', color: '#16a34a', align: 'center' },
      ]},
      { type: 'box', layout: 'vertical', flex: 1, spacing: 'xs', backgroundColor: '#eff6ff', paddingAll: 'sm', cornerRadius: '6px', contents: [
        { type: 'text', text: '🔢 จำนวนขอ', size: 'xxs', color: '#999999', align: 'center' },
        { type: 'text', text: String(totalReq), size: 'lg', weight: 'bold', color: '#2563eb', align: 'center' },
      ]},
      { type: 'box', layout: 'vertical', flex: 1, spacing: 'xs', backgroundColor: '#f0fdf4', paddingAll: 'sm', cornerRadius: '6px', contents: [
        { type: 'text', text: '✅ อนุมัติ', size: 'xxs', color: '#999999', align: 'center' },
        { type: 'text', text: String(totalApp), size: 'lg', weight: 'bold', color: '#16a34a', align: 'center' },
      ]},
    ]});
  }

  if (itemBoxes.length > 0) {
    bodyContents.push({ type: 'separator', margin: 'md' });
    bodyContents.push({ type: 'text', text: '🧾 รายการวัสดุ (' + (dets || []).length + ' รายการ)', weight: 'bold', size: 'sm', color: '#555555', margin: 'md' });
    bodyContents.push({ type: 'box', layout: 'vertical', spacing: 'xs', margin: 'sm', contents: itemBoxes });
  }

  if (req.approvedBy) {
    bodyContents.push({ type: 'separator', margin: 'md' });
    bodyContents.push({ type: 'box', layout: 'baseline', margin: 'md', contents: [
      { type: 'text', text: '✍️ ดำเนินการโดย', size: 'xs', color: '#999999', flex: 4 },
      { type: 'text', text: String(req.approvedBy), size: 'sm', color: '#333333', flex: 6, weight: 'bold' }
    ]});
  }

  if (detail && (status === 'ปฏิเสธ' || status === 'อนุมัติบางส่วน')) {
    bodyContents.push({ type: 'separator', margin: 'md' });
    bodyContents.push({ type: 'box', layout: 'vertical', spacing: 'xs',
      backgroundColor: status === 'ปฏิเสธ' ? '#fef2f2' : '#fffbeb',
      paddingAll: 'sm', cornerRadius: '6px', margin: 'md',
      contents: [
        { type: 'text', text: status === 'ปฏิเสธ' ? '❌ เหตุผลการปฏิเสธ' : '⚠️ หมายเหตุ', size: 'xs', color: status === 'ปฏิเสธ' ? '#dc2626' : '#d97706', weight: 'bold' },
        { type: 'text', text: String(detail).substring(0, 250), size: 'xs', color: '#555555', wrap: true, margin: 'xs' }
      ]
    });
  }

  return {
    type: 'flex',
    altText: c.emoji + ' อัปเดตใบเบิก: ' + c.label + ' — ' + req.requestId,
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical',
        backgroundColor: c.bg, paddingAll: 'lg',
        contents: [
          { type: 'text', text: c.emoji + ' อัปเดตใบเบิก: ' + c.label, color: '#ffffff', weight: 'bold', size: 'lg' },
          { type: 'text', text: req.requestId, color: '#ffffffcc', size: 'xs', margin: 'xs' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg',
        contents: bodyContents,
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'md',
        contents: [
          { type: 'text', text: '🕐 ' + nowThai(), size: 'xxs', color: '#aaaaaa', align: 'center' },
          { type: 'text', text: branding.org_name || 'ระบบเบิกวัสดุคลัง', size: 'xs', color: '#999999', align: 'center' },
        ],
      },
    },
  };
}

function buildFlexLowStock(lowItems) {
  const branding = getBrandingObject();
  const items = lowItems.slice(0, 8);
  const hasMore = lowItems.length > 8;
 
  const itemBoxes = items.map((it, i) => ({
    type: 'box', layout: 'horizontal', spacing: 'sm',
    contents: [
      { type: 'text', text: String(i + 1) + '.', size: 'xs', color: '#999999', flex: 1 },
      { type: 'text', text: String(it.name || ''), size: 'sm', color: '#333333', flex: 6, wrap: true },
      { type: 'text', text: String(it.qty) + '/' + String(it.minQty), size: 'sm', color: '#dc2626', flex: 3, align: 'end', weight: 'bold' },
    ],
  }));
  if (hasMore) {
    itemBoxes.push({
      type: 'text',
      text: '… และอีก ' + (lowItems.length - 8) + ' รายการ',
      size: 'xs', color: '#999999', align: 'center', margin: 'sm',
    });
  }
 
  return {
    type: 'flex',
    altText: '⚠️ วัสดุใกล้หมด ' + lowItems.length + ' รายการ',
    contents: {
      type: 'bubble', size: 'mega',
 
      // ── Header + การ์ตูน ──
      header: {
  type: 'box', layout: 'horizontal',
  backgroundColor: '#dc2626', paddingAll: 'lg',
  contents: [
    {
      type: 'box', layout: 'vertical', flex: 4, justifyContent: 'center',
      contents: [
        { type: 'text', text: '⚠️ วัสดุใกล้หมด', color: '#ffffff', weight: 'bold', size: 'xl' },
        { type: 'text', text: 'พบ ' + lowItems.length + ' รายการต่ำกว่าเกณฑ์ขั้นต่ำ', color: '#ffffffcc', size: 'xs', margin: 'xs' },
      ],
    },
    {
      type: 'image',
      url: CARTOON.LOW_STOCK,
      flex: 2,
      size: 'sm',
      aspectMode: 'fit',
      aspectRatio: '1:1',
    },
  ],
},
 
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          {
            type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [
              { type: 'text', text: 'ลำดับ', size: 'xxs', color: '#999999', flex: 1, weight: 'bold' },
              { type: 'text', text: 'ชื่อวัสดุ', size: 'xxs', color: '#999999', flex: 6, weight: 'bold' },
              { type: 'text', text: 'เหลือ/ขั้นต่ำ', size: 'xxs', color: '#999999', flex: 3, weight: 'bold', align: 'end' },
            ],
          },
          { type: 'separator', margin: 'sm' },
          { type: 'box', layout: 'vertical', spacing: 'xs', contents: itemBoxes },
        ],
      },
 
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: '🕐 ' + nowThai(), size: 'xxs', color: '#aaaaaa', align: 'center' },
          { type: 'text', text: branding.org_name || 'ระบบเบิกวัสดุคลัง', size: 'xs', color: '#999999', align: 'center' },
        ],
      },
    },
  };
}

// ══════════════════════════════════════════════════════════
//  Notify Functions
// ══════════════════════════════════════════════════════════

function notifyNewRequest(req, dets) {
  if (!req || !_shouldNotify('new')) return false;
  const textFallback = '📦 ใบเบิกวัสดุใหม่\n━━━━━━━━━━━━━━━━━━━\n📋 เลขที่: ' + req.requestId +
    '\n👤 ผู้เบิก: ' + req.requesterName + '\n🏢 หน่วยงาน: ' + req.department +
    '\n🎯 วัตถุประสงค์: ' + (req.purpose || '–') + '\n📅 วันที่: ' + (req.requestDate || '') +
    '\n🧾 รายการ: ' + ((dets || []).length) + ' รายการ\n━━━━━━━━━━━━━━━━━━━\nกรุณาเข้า Admin Panel เพื่ออนุมัติ';
  try {
    return pushToAdmins(buildFlexNewRequest(req, dets));
  } catch(e) {
    Logger.log('notifyNewRequest flex error: ' + e.message);
    return pushToAdmins(textFallback);
  }
}

// ══════════════════════════════════════════════════════════
//  ✅ PATCHED v5.2.6: notifyRequestStatus
//  - ไม่คืนค่า undefined อีกต่อไป → คืน object บอกผลชัดเจนว่า
//    ส่งถึงผู้เบิกไหม / ส่งถึงแอดมินไหม / ถ้าไม่ส่งเพราะอะไร
//  - Logger.log ละเอียดทุกขั้นตอน เพื่อไล่ดูใน Executions ได้ง่าย
//  - จับคู่ผู้ใช้ด้วยชื่อ+หน่วยงานแบบ trim ช่องว่างหัวท้ายกันเผลอ
//    เว้นวรรคเกินจนหาไม่เจอ
// ══════════════════════════════════════════════════════════
function notifyRequestStatus(requestId, status, detail) {
  const result = { requestId: requestId, status: status, lineEnabled: false, shouldNotify: false,
                    userFound: false, userHasLineId: false, sentToUser: false, sentToAdmin: false,
                    adminIdsConfigured: false, tokenConfigured: false, errors: [] };

  if (!isLineEnabled()) {
    Logger.log('[notifyRequestStatus] ข้าม: ปิดการแจ้งเตือน LINE ทั้งระบบ (line_notify_enabled=false)');
    return result;
  }
  result.lineEnabled = true;

  const statusNotifyMap = { 'อนุมัติ': 'approve', 'อนุมัติบางส่วน': 'approve', 'ปฏิเสธ': 'reject', 'ยกเลิก': 'reject' };
  if (!_shouldNotify(statusNotifyMap[status] || 'approve')) {
    Logger.log('[notifyRequestStatus] ข้าม: ปิดการแจ้งเตือนประเภทนี้ (' + (statusNotifyMap[status] || 'approve') + ') ไว้ในการตั้งค่า');
    return result;
  }
  result.shouldNotify = true;

  const req  = rows(SH.REQUESTS).find(r => r.requestId === requestId);
  const dets = rows(SH.DETAIL).filter(d => d.requestId === requestId);
  if (!req) {
    result.errors.push('ไม่พบใบเบิก ' + requestId + ' ในชีต Requests');
    Logger.log('[notifyRequestStatus] ' + result.errors[0]);
    return result;
  }

  result.tokenConfigured = !!_getLineChannelToken();
  result.adminIdsConfigured = _getAdminLineUserIds().length > 0;
  if (!result.tokenConfigured) Logger.log('[notifyRequestStatus] ⚠️ ไม่พบ LINE Channel Access Token');

  // ── หาผู้เบิกด้วยชื่อ+หน่วยงาน (ตัดช่องว่างหัวท้ายกันพลาด) ──
  const normReqName = String(req.requesterName || '').trim();
  const normReqDept = String(req.department || '').trim();
  const users = rows(SH.USERS);
  const user  = users.find(u =>
    String(u.name || '').trim() === normReqName &&
    String(u.department || '').trim() === normReqDept
  );
  result.userFound = !!user;
  const lineId = user && user.lineUserId ? String(user.lineUserId).trim() : '';
  result.userHasLineId = !!(lineId && lineId.startsWith('U'));

  if (!result.userFound) {
    result.errors.push('ไม่พบผู้ใช้ "' + normReqName + '" หน่วยงาน "' + normReqDept + '" ในชีต Users (ชื่อ/หน่วยงานอาจสะกดไม่ตรงกับตอนลงทะเบียน)');
    Logger.log('[notifyRequestStatus] ' + result.errors[result.errors.length - 1]);
  } else if (!result.userHasLineId) {
    result.errors.push('ผู้ใช้ "' + normReqName + '" ยังไม่ได้ผูก LINE (ยังไม่พิมพ์ "ลงทะเบียน ชื่อ หน่วยงาน" ในแชทบอท)');
    Logger.log('[notifyRequestStatus] ' + result.errors[result.errors.length - 1]);
  }

  if (result.userHasLineId) {
    try {
      const r = pushLineMessage(lineId, buildFlexStatusUpdate(req, dets, status, detail));
      result.sentToUser = !!(r && r.success);
      if (!result.sentToUser) result.errors.push('ส่งหาผู้เบิกไม่สำเร็จ: ' + (r && (r.error || r.message) || 'ไม่ทราบสาเหตุ'));
      Logger.log('[notifyRequestStatus] ส่ง Flex ไปยังผู้เบิก (' + lineId + ') → ' + (result.sentToUser ? 'สำเร็จ' : 'ไม่สำเร็จ: ' + JSON.stringify(r)));
    } catch(e) {
      Logger.log('[notifyRequestStatus] Flex user error: ' + e.message + ' → ลอง fallback เป็นข้อความธรรมดา');
      try {
        const emojiMap = { 'อนุมัติ':'✅','อนุมัติบางส่วน':'⚠️','ปฏิเสธ':'❌','ยกเลิก':'🚫' };
        const r2 = pushLineMessage(lineId, (emojiMap[status] || '📋') + ' ผลใบเบิกของท่าน\n━━━━━━━━━━━━━━━━━━━\n📋 เลขที่: ' + req.requestId + '\n📊 สถานะ: ' + status + (detail ? '\n📝 หมายเหตุ: ' + detail : '') + '\n━━━━━━━━━━━━━━━━━━━');
        result.sentToUser = !!(r2 && r2.success);
        if (!result.sentToUser) result.errors.push('Fallback ส่งหาผู้เบิกก็ไม่สำเร็จ: ' + (r2 && (r2.error || r2.message) || e.message));
      } catch(e2) {
        result.errors.push('ส่งหาผู้เบิกล้มเหลวทั้งแบบ Flex และ fallback: ' + e2.message);
        Logger.log('[notifyRequestStatus] Fallback user error: ' + e2.message);
      }
    }
  }

  try {
    const r3 = pushToAdmins(buildFlexAdminStatusUpdate(req, dets, status, detail));
    result.sentToAdmin = !!r3;
    Logger.log('[notifyRequestStatus] ส่ง Flex ไปยังแอดมิน → ' + (result.sentToAdmin ? 'สำเร็จ' : 'ไม่สำเร็จ'));
  } catch(e) {
    Logger.log('[notifyRequestStatus] Flex admin status error: ' + e.message + ' → ลอง fallback เป็นข้อความธรรมดา');
    try {
      const emojiMap = { 'อนุมัติ':'✅','อนุมัติบางส่วน':'⚠️','ปฏิเสธ':'❌','ยกเลิก':'🚫' };
      const r4 = pushToAdmins((emojiMap[status] || '📋') + ' อัปเดตใบเบิก: ' + status +
        '\n━━━━━━━━━━━━━━━━━━━\n📋 เลขที่: ' + req.requestId +
        '\n👤 ผู้เบิก: ' + req.requesterName + ' (' + req.department + ')' +
        '\n📊 สถานะ: ' + status + (detail ? '\n📝 รายละเอียด: ' + detail : '') +
        '\n✍️ ดำเนินการโดย: ' + (req.approvedBy || '–') + '\n━━━━━━━━━━━━━━━━━━━');
      result.sentToAdmin = !!r4;
      if (!result.sentToAdmin) result.errors.push('ส่งหาแอดมินไม่สำเร็จทั้งแบบ Flex และ fallback');
    } catch(e2) {
      result.errors.push('ส่งหาแอดมินล้มเหลวทั้งแบบ Flex และ fallback: ' + e2.message);
      Logger.log('[notifyRequestStatus] Fallback admin error: ' + e2.message);
    }
  }

  if (!result.sentToAdmin && !result.tokenConfigured) result.errors.push('ไม่ได้ตั้งค่า LINE Channel Access Token — ระบบส่งแจ้งเตือนไม่ได้เลย');
  if (!result.sentToAdmin && result.tokenConfigured && !result.adminIdsConfigured) result.errors.push('ยังไม่ได้ตั้งค่า LINE User ID ของแอดมิน (line_admin_user_ids) — จะ broadcast แทน ถ้าไม่มีคนติดตามจะไม่มีใครได้รับ');

  return result;
}

function notifyLowStock(lowItems) {
  if (!lowItems || !lowItems.length || !_shouldNotify('low_stock')) return;
  try {
    pushToAdmins(buildFlexLowStock(lowItems));
  } catch(e) {
    Logger.log('Flex low stock error: ' + e.message);
    const lines = lowItems.slice(0, 10).map(it => '  • ' + it.name + ': เหลือ ' + it.qty + ' ' + (it.unit||'') + ' (ขั้นต่ำ ' + it.minQty + ')').join('\n');
    pushToAdmins('⚠️ วัสดุคลังใกล้หมด!\n━━━━━━━━━━━━━━━━━━━\n🔴 พบ ' + lowItems.length + ' รายการต่ำกว่าเกณฑ์:\n' + lines + '\n━━━━━━━━━━━━━━━━━━━\n🕐 ' + nowThai());
  }
}

function saveUserLineId(name, department, lineUserId) {
  const cleanName   = String(name || '').trim();
  const cleanDept   = String(department || '').trim();
  const cleanLineId = String(lineUserId || '').trim();
  if (!cleanName || !cleanDept || !cleanLineId) return false;
  const users = rows(SH.USERS);
  let user = users.find(u => String(u.name || '').trim() === cleanName && String(u.department || '').trim() === cleanDept);
  if (!user) {
    user = { userId: uid('USR'), name: cleanName, department: cleanDept, email: '', lineUserId: cleanLineId, isActive: true, totalRequests: 0, lastLogin: now(), createdAt: new Date().toISOString() };
    addRow(SH.USERS, user);
    return true;
  }
  return setRow(SH.USERS, 'userId', user.userId, { lineUserId: cleanLineId });
}

function updateUserLineId(json) {
  try {
    const data = JSON.parse(json || '{}');
    const userId   = String(data.userId || '').trim();
    const lineUserId = String(data.lineUserId || '').trim();
    if (!userId || !lineUserId) return JSON.stringify({ success: false, error: 'ข้อมูลไม่ครบ' });
    if (!lineUserId.startsWith('U')) return JSON.stringify({ success: false, error: 'LINE User ID ต้องขึ้นต้นด้วย U' });
    return JSON.stringify({ success: setRow(SH.USERS, 'userId', userId, { lineUserId }) });
  } catch (err) {
    return JSON.stringify({ success: false, error: err.message });
  }
}

// ══════════════════════════════════════════════════════════
//  BRANDING
// ══════════════════════════════════════════════════════════

function getBrandingObject() {
  return {
    logo_url           : getSettingValue('logo_url', DEFAULT_BRANDING.logo_url),
    org_name           : getSettingValue('org_name', DEFAULT_BRANDING.org_name),
    org_subtitle       : getSettingValue('org_subtitle', DEFAULT_BRANDING.org_subtitle),
    org_full_name      : getSettingValue('org_full_name', DEFAULT_BRANDING.org_full_name),
    org_full_subtitle  : getSettingValue('org_full_subtitle', DEFAULT_BRANDING.org_full_subtitle),
    theme_preset       : getSettingValue('theme_preset', DEFAULT_BRANDING.theme_preset),
    theme_primary      : getSettingValue('theme_primary', DEFAULT_BRANDING.theme_primary),
    theme_primary_dark : getSettingValue('theme_primary_dark', DEFAULT_BRANDING.theme_primary_dark),
    theme_primary_light: getSettingValue('theme_primary_light', DEFAULT_BRANDING.theme_primary_light),
  };
}

function getPublicSettings() { initSheets(); return JSON.stringify(getBrandingObject()); }
function getBrandingSettings() { initSheets(); return JSON.stringify(Object.assign({}, getBrandingObject(), { presets: THEME_PRESETS })); }

function saveBrandingSettings(json) {
  try {
    initSheets();
    const data = JSON.parse(json || '{}');
    if (data.theme_preset && THEME_PRESETS[data.theme_preset]) {
      const p = THEME_PRESETS[data.theme_preset];
      data.theme_primary = p.primary; data.theme_primary_dark = p.dark; data.theme_primary_light = p.light;
    }
    ['logo_url','org_name','org_subtitle','org_full_name','org_full_subtitle','theme_preset','theme_primary','theme_primary_dark','theme_primary_light'].forEach(f => {
      if (data[f] !== undefined && data[f] !== null) saveSettingValue(f, String(data[f]));
    });
    return JSON.stringify({ success: true, message: 'บันทึกการตั้งค่าโลโก้ & ธีมสำเร็จ', branding: getBrandingObject() });
  } catch (err) { return JSON.stringify({ success: false, error: err.message }); }
}

function resetBrandingDefaults() {
  try { Object.keys(DEFAULT_BRANDING).forEach(k => saveSettingValue(k, DEFAULT_BRANDING[k])); return JSON.stringify({ success: true, branding: getBrandingObject() }); }
  catch(err) { return JSON.stringify({ success: false, error: err.message }); }
}

function saveBranding(json) {
  try {
    const data = JSON.parse(json || '{}');
    let logoUrl = String(data.logoUrl == null ? '' : data.logoUrl).trim();
    if (logoUrl.indexOf('data:image/') === 0) {
      const up = JSON.parse(uploadLogoFile(JSON.stringify({ dataUrl: logoUrl, fileName: 'logo' })));
      if (!up.success) return JSON.stringify({ success: false, error: 'อัปโหลด Drive ล้มเหลว: ' + up.error });
      logoUrl = up.url;
    } else if (data.logoUrl !== undefined) { saveSettingValue('logo_url', logoUrl); }
    if (logoUrl) saveSettingValue('logo_url', logoUrl);
    if (data.appName !== undefined) saveSettingValue('org_name', data.appName || DEFAULT_BRANDING.org_name);
    return JSON.stringify({ success: true, logoUrl: logoUrl });
  } catch (err) { return JSON.stringify({ success: false, error: err.message }); }
}

function getBranding() {
  initSheets();
  return JSON.stringify({ logoUrl: getSettingValue('logo_url', ''), appName: getSettingValue('org_name', DEFAULT_BRANDING.org_name) });
}

function uploadLogoFile(json) {
  try {
    const data = JSON.parse(json || '{}');
    const dataUrl  = String(data.dataUrl || '').trim();
    const fileName = String(data.fileName || 'logo.png').trim();
    if (!dataUrl) return JSON.stringify({ success: false, error: 'ไม่พบข้อมูลรูป' });
    const m = dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
    if (!m) return JSON.stringify({ success: false, error: 'รูปแบบไฟล์ไม่ถูกต้อง (ต้องเป็น data URL)' });
    const mimeType = m[1];
    const ext = (mimeType.split('/')[1] || 'png').replace('+xml', '').replace('jpeg', 'jpg');
    const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), mimeType, 'logo_' + Date.now() + '.' + ext);
    const oldUrl = String(getSettingValue('logo_url', '')).trim();
    if (oldUrl && oldUrl.indexOf('drive.google.com') >= 0) {
      const om = oldUrl.match(/[?&]id=([^&]+)/) || oldUrl.match(/\/d\/([^/]+)/);
      if (om && om[1]) { try { DriveApp.getFileById(om[1]).setTrashed(true); } catch(e){} }
    }
    const file = DriveApp.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const fileId = file.getId();
    const publicUrl = 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w400';
    saveSettingValue('logo_url', publicUrl);
    saveSettingValue('logo_file_id', fileId);
    return JSON.stringify({ success: true, url: publicUrl, fileId: fileId, message: '✅ อัปโหลดสำเร็จ' });
  } catch (err) { return JSON.stringify({ success: false, error: err.message }); }
}

function removeLogo() {
  try {
    const oldUrl = String(getSettingValue('logo_url', '')).trim();
    if (oldUrl && oldUrl.indexOf('drive.google.com') >= 0) {
      const m = oldUrl.match(/[?&]id=([^&]+)/) || oldUrl.match(/\/d\/([^/]+)/);
      if (m && m[1]) { try { DriveApp.getFileById(m[1]).setTrashed(true); } catch(e){} }
    }
    saveSettingValue('logo_url', '');
    saveSettingValue('logo_file_id', '');
    return JSON.stringify({ success: true });
  } catch (err) { return JSON.stringify({ success: false, error: err.message }); }
}

// ══════════════════════════════════════════════════════════
//  DB Helpers
// ══════════════════════════════════════════════════════════

function ss() { return SS_ID ? SpreadsheetApp.openById(SS_ID) : SpreadsheetApp.getActiveSpreadsheet(); }

function sheet(name, headers) {
  let sh = ss().getSheetByName(name);
  const wantHeaders = Array.isArray(headers) ? headers.filter(Boolean) : [];
  if (!sh) sh = ss().insertSheet(name);
  if (wantHeaders.length && sh.getLastRow() === 0) { sh.appendRow(wantHeaders); sh.setFrozenRows(1); }
  if (wantHeaders.length && sh.getLastRow() >= 1) {
    const lastCol = Math.max(sh.getLastColumn(), 1);
    const current = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(x => String(x || '').trim());
    wantHeaders.forEach(h => { if (!current.includes(h)) { sh.getRange(1, sh.getLastColumn() + 1).setValue(h); current.push(h); } });
  }
  if (wantHeaders.length && sh.getLastColumn() > 0) { sh.getRange(1, 1, 1, sh.getLastColumn()).setBackground('#0F4C81').setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(11); }
  return sh;
}

function rows(sheetName) {
  const sh = sheet(sheetName, []);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  const h = data[0];
  return data.slice(1).map(r => { const o = {}; h.forEach((k, i) => o[String(k)] = r[i]); return o; });
}

function addRow(name, obj) { const sh = sheet(name, Object.keys(obj)); const h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]; sh.appendRow(h.map(k => obj[k] !== undefined ? obj[k] : '')); }

function setRow(name, key, val, upd) {
  const sh = sheet(name, [key].concat(Object.keys(upd || {})));
  let data = sh.getDataRange().getValues();
  let h = data[0].map(x => String(x || '').trim());
  let ki = h.indexOf(key);
  if (ki < 0) { sh.getRange(1, sh.getLastColumn() + 1).setValue(key); data = sh.getDataRange().getValues(); h = data[0].map(x => String(x || '').trim()); ki = h.indexOf(key); }
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][ki]) === String(val)) {
      Object.keys(upd || {}).forEach(k => {
        let ci = h.indexOf(k);
        if (ci < 0) { sh.getRange(1, sh.getLastColumn() + 1).setValue(k); h.push(k); ci = h.length - 1; }
        sh.getRange(i + 1, ci + 1).setValue(upd[k]);
      });
      return true;
    }
  }
  return false;
}

function delRow(name, key, val) {
  const sh = sheet(name, [key]); const data = sh.getDataRange().getValues(); const ki = data[0].indexOf(key);
  for (let i = 1; i < data.length; i++) { if (String(data[i][ki]) === String(val)) { sh.deleteRow(i + 1); return true; } }
  return false;
}

function uid(prefix) { return prefix + Date.now() + Math.floor(Math.random() * 1000); }

// ══════════════════════════════════════════════════════════
//  Settings Helpers
// ══════════════════════════════════════════════════════════

function getSettingValue(key, fallback) {
  try {
    const settings = rows(SH.SETTINGS);
    const found = settings.find(s => String(s.key || '').trim() === String(key).trim());
    const v = found ? String(found.value == null ? '' : found.value).trim() : '';
    return v || (fallback == null ? '' : fallback);
  } catch (e) { return fallback == null ? '' : fallback; }
}

function saveSettingValue(key, value) {
  const t = new Date().toISOString();
  const all = rows(SH.SETTINGS);
  const cleanKey = String(key || '').trim();
  if (all.find(s => String(s.key || '').trim() === cleanKey)) { return setRow(SH.SETTINGS, 'key', cleanKey, { value, updatedAt: t }); }
  addRow(SH.SETTINGS, { key: cleanKey, value, updatedAt: t });
  return true;
}

// ══════════════════════════════════════════════════════════
//  เวลาประเทศไทย
// ══════════════════════════════════════════════════════════

function now() { return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm'); }

function nowThai() {
  const d = new Date(); const tz = 'Asia/Bangkok';
  const day   = parseInt(Utilities.formatDate(d, tz, 'dd'), 10);
  const month = parseInt(Utilities.formatDate(d, tz, 'MM'), 10);
  const year  = parseInt(Utilities.formatDate(d, tz, 'yyyy'), 10) + 543;
  const time  = Utilities.formatDate(d, tz, 'HH:mm');
  return day + ' ' + MONTHS_TH[month] + ' พ.ศ. ' + year + ' เวลา ' + time + ' น.';
}

// ══════════════════════════════════════════════════════════
//  ✅ PATCHED v5.2.3: toThaiDateFull
//  — ตัด "GMT+0700 (เวลาอินโดจีน)" ออก
//  — รองรับ Date object จาก Google Sheets
//  — รองรับทั้ง dd/MM/yyyy และ JS Date.toString()
// ══════════════════════════════════════════════════════════
function toThaiDateFull(dateStr) {
  if (!dateStr) return '–';

  // ถ้าเป็น Date object จาก Google Sheets → แปลงด้วย Utilities.formatDate
  if (dateStr instanceof Date) {
    try {
      const tz = 'Asia/Bangkok';
      const day   = parseInt(Utilities.formatDate(dateStr, tz, 'dd'), 10);
      const month = parseInt(Utilities.formatDate(dateStr, tz, 'MM'), 10);
      const year  = parseInt(Utilities.formatDate(dateStr, tz, 'yyyy'), 10) + 543;
      const time  = Utilities.formatDate(dateStr, tz, 'HH:mm');
      return day + ' ' + MONTHS_TH[month] + ' พ.ศ. ' + year + ' เวลา ' + time + ' น.';
    } catch(e) {}
  }

  let s = String(dateStr).trim();

  // ── ลบข้อความ timezone ออก เช่น "GMT+0700 (เวลาอินโดจีน)" ──
  s = s.replace(/\s*GMT[+-]\d{4}\s*\([^)]*\)/g, '').trim();

  // ── ลองแปลง dd/MM/yyyy HH:mm ก่อน ──
  const parts = s.split(' ');
  const dp = parts[0].split('/');
  if (dp.length === 3 && /^\d+$/.test(dp[0])) {
    const day = parseInt(dp[0], 10);
    const mon = parseInt(dp[1], 10);
    const rawYear = parseInt(dp[2], 10);
    if (mon >= 1 && mon <= 12) {
      const year = rawYear < 2400 ? rawYear + 543 : rawYear;
      const time = parts[1] || '';
      return day + ' ' + MONTHS_TH[mon] + ' พ.ศ. ' + year + (time ? ' เวลา ' + time + ' น.' : '');
    }
  }

  // ── ลองแปลง JS Date string เช่น "Fri May 08 2026 17:34:00" ──
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const tz = 'Asia/Bangkok';
      const day   = parseInt(Utilities.formatDate(d, tz, 'dd'), 10);
      const month = parseInt(Utilities.formatDate(d, tz, 'MM'), 10);
      const year  = parseInt(Utilities.formatDate(d, tz, 'yyyy'), 10) + 543;
      const time  = Utilities.formatDate(d, tz, 'HH:mm');
      return day + ' ' + MONTHS_TH[month] + ' พ.ศ. ' + year + ' เวลา ' + time + ' น.';
    }
  } catch(e) {}

  // ── สุดท้าย ลบ GMT ออกแล้วคืนค่าเดิม ──
  return s;
}

function fyOf(d) { const m = d.getMonth() + 1; const y = d.getFullYear(); return m >= 10 ? (y + 1) + 543 : y + 543; }

function qOf(d) {
  const m = d.getMonth() + 1;
  if (m >= 10) return Q_LABELS[0];
  if (m >= 1 && m <= 3) return Q_LABELS[1];
  if (m >= 4 && m <= 6) return Q_LABELS[2];
  return Q_LABELS[3];
}

function generateRequestId(department) {
  const fy = fyOf(new Date());
  const deptCode = (department || 'GEN').replace(/[^a-zA-Zก-ฮ]/g, '').substring(0, 3).toUpperCase();
  const existing = rows(SH.REQUESTS).filter(r => String(r.fiscalYear) === String(fy));
  return fy + '-' + deptCode + '-' + String(existing.length + 1).padStart(4, '0');
}

// ══════════════════════════════════════════════════════════
//  Init Sheets
// ══════════════════════════════════════════════════════════

function initSheets() {
  sheet(SH.ITEMS,    ['id','name','category','unit','qty','minQty','imageUrl','description','createdAt']);
  sheet(SH.REQUESTS, ['requestId','requestDate','requesterName','department','purpose','status','totalItems','note','createdAt','fiscalYear','quarter','approvedBy','approvedAt','rejReason']);
  sheet(SH.DETAIL,   ['detailId','requestId','itemId','itemName','unit','qtyRequested','qtyApproved','note']);
  sheet(SH.USERS, ['userId','name','department','email','lineUserId','isActive','totalRequests','lastLogin','lastActivity','createdAt']);
  sheet(SH.SETTINGS, ['key','value','updatedAt']);
  sheet(SH.LOG,      ['logId','itemId','itemName','action','qtyBefore','qtyChange','qtyAfter','note','operator','createdAt']);
  sheet(SH.NOTIFY,   ['notifId','type','title','message','isRead','createdAt']);
  try {
    const settings = rows(SH.SETTINGS);
    Object.keys(DEFAULT_BRANDING).forEach(k => {
      if (!settings.find(s => String(s.key || '').trim() === k)) { addRow(SH.SETTINGS, { key: k, value: DEFAULT_BRANDING[k], updatedAt: new Date().toISOString() }); }
    });
  } catch(e) { Logger.log('Init branding error: ' + e.message); }
  return JSON.stringify({ success: true });
}

// ══════════════════════════════════════════════════════════
//  Auth
// ══════════════════════════════════════════════════════════

function loginAdmin(pw) {
  try {
    initSheets();
    const input = String(pw || '').trim();
    if (!input) return JSON.stringify({ success: false, error: 'กรุณากรอกรหัสผ่าน' });
    const settings = rows(SH.SETTINGS);
    const saved    = settings.find(s => String(s.key || '').trim() === 'admin_password');
    const defaultPw = String(ADM_PW || '123456').trim();
    const savedPw   = saved ? String(saved.value || '').trim() : '';
    const ok = input === defaultPw || (savedPw && input === savedPw);
    return JSON.stringify({ success: ok, message: ok ? 'เข้าสู่ระบบสำเร็จ' : 'รหัสผ่านไม่ถูกต้อง' });
  } catch(err) { return JSON.stringify({ success: false, error: err.message || String(err) }); }
}

function loginUser(json) {
  const { name, department } = JSON.parse(json);
  if (!name || !department) return JSON.stringify({ success: false, error: 'กรุณากรอกข้อมูลให้ครบ' });
  const users = rows(SH.USERS);
  let u = users.find(x => x.name === name && x.department === department);
  if (!u) {
    u = { userId: uid('USR'), name, department, email: '', lineUserId: '', isActive: true, totalRequests: 0, lastLogin: now(), createdAt: new Date().toISOString() };
    addRow(SH.USERS, u);
  } else if (u.isActive === false || u.isActive === 'false') { return JSON.stringify({ success: false, error: 'บัญชีถูกระงับการใช้งาน' }); }
  else { setRow(SH.USERS, 'userId', u.userId, { lastLogin: now(), lastActivity: now() }); }
  return JSON.stringify({ success: true, user: { userId: u.userId, name: u.name, department: u.department } });
}

// ══════════════════════════════════════════════════════════
//  Items
// ══════════════════════════════════════════════════════════

function getItems() { return JSON.stringify(rows(SH.ITEMS)); }

function addItem(json) {
  const it = JSON.parse(json);
  it.id = uid('ITEM'); it.qty = Number(it.qty) || 0; it.minQty = Number(it.minQty) || 0;
  it.createdAt = new Date().toISOString();
  addRow(SH.ITEMS, it);
  return JSON.stringify({ success: true, id: it.id });
}

function updateItem(json) { const it = JSON.parse(json); return JSON.stringify({ success: setRow(SH.ITEMS, 'id', it.id, it) }); }
function deleteItem(id) { return JSON.stringify({ success: delRow(SH.ITEMS, 'id', id) }); }

function adjustStock(json) {
  const { itemId, delta, note, operator } = JSON.parse(json);
  const its = rows(SH.ITEMS);
  const it = its.find(x => x.id === itemId);
  if (!it) return JSON.stringify({ success: false, error: 'ไม่พบวัสดุ' });
  const before = Number(it.qty); const after = before + Number(delta);
  if (after < 0) return JSON.stringify({ success: false, error: 'สต็อกไม่เพียงพอ (คงเหลือ ' + before + ')' });
  setRow(SH.ITEMS, 'id', itemId, { qty: after });
  addRow(SH.LOG, { logId: uid('LOG'), itemId, itemName: it.name, action: delta > 0 ? 'รับเข้า' : 'จ่ายออก', qtyBefore: before, qtyChange: delta, qtyAfter: after, note: note || '', operator: operator || 'Admin', createdAt: new Date().toISOString() });
  return JSON.stringify({ success: true, newQty: after });
}

function getStockLog() { return JSON.stringify(rows(SH.LOG).reverse().slice(0, 200)); }

// ══════════════════════════════════════════════════════════
//  Export CSV
// ══════════════════════════════════════════════════════════

function exportItemsCSV() {
  const items = rows(SH.ITEMS);
  const csvRows = [['รหัส','ชื่อวัสดุ','หมวดหมู่','หน่วย','คงเหลือ','ขั้นต่ำ'].join(',')];
  items.forEach(it => csvRows.push([it.id, it.name, it.category, it.unit, it.qty, it.minQty].join(',')));
  const file = DriveApp.createFile(Utilities.newBlob('\uFEFF' + csvRows.join('\n'), 'text/csv', 'วัสดุ_' + now().replace(/[/:]/g,'-').replace(/ /g,'_') + '.csv'));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return JSON.stringify({ success: true, url: file.getDownloadUrl() });
}

function exportRequestsCSV(fy) {
  const reqs = rows(SH.REQUESTS).filter(r => !fy || String(r.fiscalYear) === String(fy));
  const csvRows = [['เลขที่','วันที่','ผู้เบิก','หน่วยงาน','วัตถุประสงค์','สถานะ','รายการ','ไตรมาส','ปีงบ'].join(',')];
  reqs.forEach(r => csvRows.push([r.requestId, r.requestDate, r.requesterName, r.department, '"' + (r.purpose||'').replace(/"/g,'""') + '"', r.status, r.totalItems, r.quarter, r.fiscalYear].join(',')));
  const file = DriveApp.createFile(Utilities.newBlob('\uFEFF' + csvRows.join('\n'), 'text/csv', 'ใบเบิก_' + (fy||'ทั้งหมด') + '.csv'));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return JSON.stringify({ success: true, url: file.getDownloadUrl() });
}

// ══════════════════════════════════════════════════════════
//  Requests
// ══════════════════════════════════════════════════════════

function getRequests() { return JSON.stringify(rows(SH.REQUESTS).reverse()); }
function getMyRequests(name, department) { return JSON.stringify(rows(SH.REQUESTS).filter(r => r.requesterName === name && r.department === department).reverse()); }
function getRequestDetails(rid) { return JSON.stringify(rows(SH.DETAIL).filter(d => d.requestId === rid)); }

// ══════════════════════════════════════════════════════════
//  ✅ PATCHED v5.2.5: submitRequest
//  — ใช้ LockService.getScriptLock() กันสองคำขอรันพร้อมกัน
//    (race condition ที่ทำให้เกิดใบเบิกซ้ำ 2 เลขที่)
//  — เช็คใบเบิกซ้ำย้อนหลัง 30 วินาที (ผู้เบิก+หน่วยงาน+
//    วัตถุประสงค์+รายการวัสดุตรงกันหมด) ถ้าซ้ำ → ไม่สร้างใหม่
//    ไม่แจ้งเตือนซ้ำ แค่คืนเลขที่ใบเบิกเดิมกลับไป
// ══════════════════════════════════════════════════════════
function submitRequest(json) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000); // รอสูงสุด 15 วินาที ถ้ามีคำขออื่นกำลังรันอยู่
  } catch (e) {
    return JSON.stringify({ success: false, error: 'ระบบกำลังประมวลผลคำขออื่นอยู่ กรุณาลองใหม่อีกครั้งใน 2-3 วินาที' });
  }

  try {
    const p = JSON.parse(json);

    // ── ✅ กันส่งซ้ำ (double submit / retry) — เช็คย้อนหลัง 30 วินาที ──
    const DUP_WINDOW_MS = 30 * 1000;
    const nowMs = Date.now();
    const recentSameUser = rows(SH.REQUESTS).filter(r => {
      if (r.requesterName !== p.requesterName) return false;
      if (r.department   !== p.department)     return false;
      if (r.purpose       !== p.purpose)        return false;
      if (!r.createdAt) return false;
      const t = new Date(r.createdAt).getTime();
      return !isNaN(t) && (nowMs - t) < DUP_WINDOW_MS;
    });

    if (recentSameUser.length) {
      const dup = recentSameUser.find(r => {
        const existingDets = rows(SH.DETAIL).filter(d => d.requestId === r.requestId);
        if (existingDets.length !== (p.items || []).length) return false;
        return (p.items || []).every(it =>
          existingDets.some(d => d.itemName === it.name && Number(d.qtyRequested) === Number(it.qty))
        );
      });
      if (dup) {
        // ⚠️ พบว่าเป็นการส่งซ้ำภายใน 30 วิ — ไม่สร้างใบเบิกใหม่ ไม่แจ้งเตือนซ้ำ
        Logger.log('⚠️ ตรวจพบการส่งใบเบิกซ้ำ — คืนเลขที่เดิม: ' + dup.requestId);
        return JSON.stringify({
          success: true,
          requestId: dup.requestId,
          fiscalYear: dup.fiscalYear,
          quarter: dup.quarter,
          duplicate: true
        });
      }
    }

    // ── สร้างใบเบิกใหม่ตามปกติ ──
    const d = new Date();
    const reqId = generateRequestId(p.department);
    const req = {
      requestId: reqId, requestDate: now(), requesterName: p.requesterName,
      department: p.department, purpose: p.purpose, status: 'รอดำเนินการ',
      totalItems: p.items.length, note: p.note || '', createdAt: d.toISOString(),
      fiscalYear: fyOf(d), quarter: qOf(d), approvedBy: '', approvedAt: '', rejReason: ''
    };
    addRow(SH.REQUESTS, req);

    const dets = [];
    p.items.forEach((it, i) => {
      const det = {
        detailId: reqId + '_' + String(i + 1).padStart(2, '0'), requestId: reqId,
        itemId: it.id, itemName: it.name, unit: it.unit,
        qtyRequested: it.qty, qtyApproved: 0, note: it.note || ''
      };
      addRow(SH.DETAIL, det); dets.push(det);
    });

    const users = rows(SH.USERS);
    const u = users.find(x => x.name === p.requesterName && x.department === p.department);
    if (u) setRow(SH.USERS, 'userId', u.userId, { totalRequests: (Number(u.totalRequests) || 0) + 1 });

    try { notifyNewRequest(req, dets); } catch (e) { Logger.log('LINE notify error: ' + e.message); }

    return JSON.stringify({ success: true, requestId: reqId, fiscalYear: fyOf(d), quarter: qOf(d) });
  } finally {
    lock.releaseLock();
  }
}

function approveRequest(json) {
  const { requestId, operator, notes } = JSON.parse(json);
  const dets = rows(SH.DETAIL).filter(d => d.requestId === requestId);
  let stockError = '';
  dets.forEach(d => {
    const res = JSON.parse(adjustStock(JSON.stringify({ itemId: d.itemId, delta: -Number(d.qtyRequested), note: 'อนุมัติใบเบิก ' + requestId, operator: operator || 'Admin' })));
    if (!res.success) stockError += d.itemName + ': ' + res.error + '. ';
    else setRow(SH.DETAIL, 'detailId', d.detailId, { qtyApproved: d.qtyRequested });
  });
  const finalStatus = stockError ? 'อนุมัติบางส่วน' : 'อนุมัติ';
  setRow(SH.REQUESTS, 'requestId', requestId, { status: finalStatus, approvedBy: operator || 'Admin', approvedAt: now(), note: notes || '' });
  let notifyInfo = null;
  try { notifyInfo = notifyRequestStatus(requestId, finalStatus, stockError || notes || ''); } catch(e) { notifyInfo = { errors: ['notifyRequestStatus พัง: ' + e.message] }; }
  try { sendApprovalEmail(requestId, 'อนุมัติ', stockError); } catch(e) {}
  return JSON.stringify({ success: true, warning: stockError || null, notifyInfo: notifyInfo });
}

// ══════════════════════════════════════════════════════════
//  ✅ อนุมัติแบบรายรายการ (บางรายการอนุมัติ บางรายการไม่อนุมัติ)
//  items: [{ itemId, qtyApproved }]  — qtyApproved=0 คือไม่อนุมัติรายการนั้น
// ══════════════════════════════════════════════════════════
function approveRequestItems(json) {
  const { requestId, items, operator } = JSON.parse(json);
  const dets = rows(SH.DETAIL).filter(d => d.requestId === requestId);
  if (!dets.length) return JSON.stringify({ success: false, error: 'ไม่พบรายการวัสดุของใบเบิกนี้' });

  let stockError = '';
  dets.forEach(d => {
    const it = items.find(x => String(x.itemId) === String(d.itemId));
    const qtyApproved = it ? Math.max(0, Math.min(Number(it.qtyApproved) || 0, Number(d.qtyRequested))) : 0;
    if (qtyApproved > 0) {
      const res = JSON.parse(adjustStock(JSON.stringify({ itemId: d.itemId, delta: -qtyApproved, note: 'อนุมัติ(บางส่วน)ใบเบิก ' + requestId, operator: operator || 'Admin' })));
      if (!res.success) { stockError += d.itemName + ': ' + res.error + '. '; setRow(SH.DETAIL, 'detailId', d.detailId, { qtyApproved: 0 }); }
      else setRow(SH.DETAIL, 'detailId', d.detailId, { qtyApproved: qtyApproved });
    } else {
      setRow(SH.DETAIL, 'detailId', d.detailId, { qtyApproved: 0 });
    }
  });

  const finalDets = rows(SH.DETAIL).filter(d => d.requestId === requestId);
  const allFull = finalDets.every(d => Number(d.qtyApproved) === Number(d.qtyRequested));
  const anyApproved = finalDets.some(d => Number(d.qtyApproved) > 0);
  const finalStatus = allFull ? 'อนุมัติ' : (anyApproved ? 'อนุมัติบางส่วน' : 'ปฏิเสธ');
  const rejReasonIfNone = anyApproved ? '' : 'ไม่อนุมัติรายการวัสดุที่ขอเบิกทั้งหมด';

  setRow(SH.REQUESTS, 'requestId', requestId, { status: finalStatus, approvedBy: operator || 'Admin', approvedAt: now(), rejReason: rejReasonIfNone });
  let notifyInfo = null;
  try { notifyInfo = notifyRequestStatus(requestId, finalStatus, stockError || rejReasonIfNone || ''); } catch (e) { notifyInfo = { errors: ['notifyRequestStatus พัง: ' + e.message] }; }
  try { sendApprovalEmail(requestId, finalStatus === 'ปฏิเสธ' ? 'ปฏิเสธ' : 'อนุมัติ', stockError || rejReasonIfNone); } catch (e) {}

  return JSON.stringify({ success: true, warning: stockError || null, status: finalStatus, notifyInfo: notifyInfo });
}

function bulkApproveRequests(json) {
  const { requestIds, operator } = JSON.parse(json);
  const results = [];
  requestIds.forEach(rid => {
    try { const res = JSON.parse(approveRequest(JSON.stringify({ requestId: rid, operator }))); results.push({ requestId: rid, success: res.success, warning: res.warning, notifyInfo: res.notifyInfo }); }
    catch(e) { results.push({ requestId: rid, success: false, error: e.message }); }
  });
  return JSON.stringify({ success: true, results });
}

// ══════════════════════════════════════════════════════════
//  ✅ NEW: diagnoseRequestNotify — เช็คสาเหตุที่แจ้งเตือนไม่มา
//  โดยไม่ต้องเปลี่ยนสถานะใบเบิกจริง (ปลอดภัย เรียกได้ตลอด)
//  เรียกจาก Admin Panel ปุ่ม "🔔 ตรวจสอบแจ้งเตือน"
// ══════════════════════════════════════════════════════════
function diagnoseRequestNotify(requestId) {
  const out = { requestId: requestId, checks: [], ok: true, summary: '' };
  const push = (label, pass, note) => { out.checks.push({ label, pass, note: note || '' }); if (!pass) out.ok = false; };

  try {
    const req = rows(SH.REQUESTS).find(r => r.requestId === requestId);
    if (!req) { push('พบใบเบิกในระบบ', false, 'ไม่พบเลขที่ ' + requestId); out.summary = '⚠️ ไม่พบใบเบิกนี้ในระบบ'; return JSON.stringify(out); }
    push('พบใบเบิกในระบบ', true);

    push('เปิดใช้งานแจ้งเตือน LINE โดยรวม', isLineEnabled(), isLineEnabled() ? '' : 'line_notify_enabled = false ใน Settings');

    const token = _getLineChannelToken();
    push('ตั้งค่า Channel Access Token แล้ว', !!token, token ? '' : 'ไปที่การตั้งค่า LINE แล้วกรอก Token ให้ครบ');

    const adminIds = _getAdminLineUserIds();
    push('ตั้งค่า LINE User ID ของแอดมินแล้ว', adminIds.length > 0, adminIds.length > 0 ? adminIds.length + ' คน' : 'ยังไม่ตั้งค่า line_admin_user_ids — จะ broadcast แทน (เสี่ยงไม่มีคนได้รับ)');

    const notifyApprove = String(getSettingValue('line_notify_approve', 'true')) !== 'false';
    push('เปิดแจ้งเตือน "อนุมัติ/ปฏิเสธ" แล้ว', notifyApprove, notifyApprove ? '' : 'line_notify_approve ถูกปิดไว้');

    const normReqName = String(req.requesterName || '').trim();
    const normReqDept = String(req.department || '').trim();
    const users = rows(SH.USERS);
    const user = users.find(u => String(u.name || '').trim() === normReqName && String(u.department || '').trim() === normReqDept);
    push('พบผู้เบิกในชีต Users (ชื่อ+หน่วยงานตรงกัน)', !!user, user ? '' : ('ผู้เบิกในใบเบิกคือ "' + normReqName + '" / "' + normReqDept + '" — ไม่พบตรงกันในชีต Users'));

    const lineId = user && user.lineUserId ? String(user.lineUserId).trim() : '';
    const hasLine = !!(lineId && lineId.startsWith('U'));
    push('ผู้เบิกลงทะเบียน LINE แล้ว (มี lineUserId)', hasLine, hasLine ? '' : 'ให้ผู้เบิกพิมพ์ "ลงทะเบียน ' + normReqName + ' ' + normReqDept + '" ในแชท LINE บอท');

    out.summary = out.ok
      ? '✅ ทุกอย่างพร้อม ถ้ายังไม่ได้แจ้งเตือนให้ลองกดปุ่มทดสอบแจ้งเตือนในหน้าตั้งค่า หรือดู Executions log'
      : '⚠️ พบจุดที่ต้องแก้ไขก่อนการแจ้งเตือนจะทำงานได้';
  } catch (e) {
    push('ตรวจสอบสำเร็จโดยไม่มี error ภายใน', false, 'เกิดข้อผิดพลาดภายในระหว่างตรวจสอบ: ' + e.message);
    out.summary = '❌ ตรวจสอบไม่สมบูรณ์ — เกิด error ภายใน: ' + e.message;
  }
  return JSON.stringify(out);
}

function rejectRequest(json) {
  const { requestId, reason, operator } = JSON.parse(json);
  setRow(SH.REQUESTS, 'requestId', requestId, { status: 'ปฏิเสธ', approvedBy: operator || 'Admin', approvedAt: now(), rejReason: reason || '' });
  let notifyInfo = null;
  try { notifyInfo = notifyRequestStatus(requestId, 'ปฏิเสธ', reason || ''); } catch(e) { notifyInfo = { errors: ['notifyRequestStatus พัง: ' + e.message] }; }
  try { sendApprovalEmail(requestId, 'ปฏิเสธ', reason); } catch(e) {}
  return JSON.stringify({ success: true, notifyInfo: notifyInfo });
}

function cancelRequest(json) {
  const { requestId } = JSON.parse(json);
  const req = rows(SH.REQUESTS).find(r => r.requestId === requestId);
  if (!req || req.status !== 'รอดำเนินการ') return JSON.stringify({ success: false, error: 'ไม่สามารถยกเลิกได้' });
  setRow(SH.REQUESTS, 'requestId', requestId, { status: 'ยกเลิก' });
  try { notifyRequestStatus(requestId, 'ยกเลิก', ''); } catch(e) {}
  return JSON.stringify({ success: true });
}

// ══════════════════════════════════════════════════════════
//  Email
// ══════════════════════════════════════════════════════════

function sendApprovalEmail(requestId, status, detail) {
  const req  = rows(SH.REQUESTS).find(r => r.requestId === requestId);
  const user = req && rows(SH.USERS).find(u => u.name === req.requesterName);
  if (!user || !user.email) return;
  const statusTh = status === 'อนุมัติ' ? '✅ อนุมัติแล้ว' : '❌ ปฏิเสธ';
  GmailApp.sendEmail(user.email, '[ระบบเบิกวัสดุ] ใบเบิก ' + requestId + ' — ' + statusTh,
    ['เรียน ' + req.requesterName, 'ใบเบิกวัสดุของท่านได้รับการดำเนินการแล้ว', '• เลขที่ใบเบิก: ' + requestId, '• สถานะ: ' + statusTh, detail ? '• หมายเหตุ: ' + detail : '', 'ระบบเบิกวัสดุคลัง'].filter(Boolean).join('\n\n')
  );
}

function sendLowStockAlert() {
  const low = rows(SH.ITEMS).filter(i => Number(i.qty) <= Number(i.minQty) && Number(i.qty) >= 0);
  if (low.length) { try { notifyLowStock(low); } catch(e) {} }
  if (!low.length) return JSON.stringify({ success: true, message: 'ไม่มีวัสดุใกล้หมด', count: 0 });
  const settings = rows(SH.SETTINGS);
  const adminEmail = (settings.find(s => s.key === 'admin_email') || {}).value;
  if (!adminEmail) return JSON.stringify({ success: true, message: 'ส่ง LINE/Discord แล้ว (ไม่ได้ตั้งค่า admin_email)', count: low.length });
  const rowsHtml = low.map(i => '<tr><td>' + i.name + '</td><td style="color:red;font-weight:bold">' + i.qty + '</td><td>' + i.minQty + '</td></tr>').join('');
  GmailApp.sendEmail(adminEmail, '[ระบบเบิกวัสดุ] แจ้งเตือนวัสดุใกล้หมด ' + low.length + ' รายการ', '', {
    htmlBody: '<h3>⚠️ วัสดุใกล้หมด</h3><table border="1" cellpadding="8"><tr><th>วัสดุ</th><th>คงเหลือ</th><th>ขั้นต่ำ</th></tr>' + rowsHtml + '</table><p>' + nowThai() + '</p>'
  });
  return JSON.stringify({ success: true, count: low.length });
}

// ══════════════════════════════════════════════════════════
//  Users
// ══════════════════════════════════════════════════════════

function getUsers() { return JSON.stringify(rows(SH.USERS)); }
function updateUserEmail(json) { const { userId, email } = JSON.parse(json); return JSON.stringify({ success: setRow(SH.USERS, 'userId', userId, { email }) }); }
function toggleUser(userId) { const u = rows(SH.USERS).find(x => x.userId === userId); if (!u) return JSON.stringify({ success: false }); return JSON.stringify({ success: setRow(SH.USERS, 'userId', userId, { isActive: !(u.isActive === true || u.isActive === 'true') }) }); }
function deleteUser(userId) { return JSON.stringify({ success: delRow(SH.USERS, 'userId', userId) }); }

// ══════════════════════════════════════════════════════════
//  Settings
// ══════════════════════════════════════════════════════════

function getSettings() { return JSON.stringify(rows(SH.SETTINGS)); }
function saveSetting(json) { const { key, value } = JSON.parse(json); saveSettingValue(key, value); return JSON.stringify({ success: true }); }

// ══════════════════════════════════════════════════════════
//  Statistics
// ══════════════════════════════════════════════════════════

function getStatistics(fy) {
  const reqs = rows(SH.REQUESTS); const dets = rows(SH.DETAIL); const its = rows(SH.ITEMS);
  const fyN = Number(fy) || fyOf(new Date());
  const fr = reqs.filter(r => Number(r.fiscalYear) === fyN);
  const byQ = {}, byDept = {}, byStatus = {}, itemCount = {};
  Q_LABELS.forEach(q => { byQ[q] = 0; });
  fr.forEach(r => {
    byQ[r.quarter||'ไม่ระบุ'] = (byQ[r.quarter||'ไม่ระบุ'] || 0) + 1;
    byDept[r.department||'ไม่ระบุ'] = (byDept[r.department||'ไม่ระบุ'] || 0) + 1;
    byStatus[r.status||'ไม่ระบุ'] = (byStatus[r.status||'ไม่ระบุ'] || 0) + 1;
    dets.filter(x => x.requestId === r.requestId).forEach(x => { itemCount[x.itemName] = (itemCount[x.itemName] || 0) + Number(x.qtyRequested); });
  });
  const topItems = Object.entries(itemCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, q]) => ({ name: n, qty: q }));
  const lowStock = its.filter(x => Number(x.qty) <= Number(x.minQty) && Number(x.qty) >= 0);
  const byQuarterDept = {};
  Q_LABELS.forEach(q => { byQuarterDept[q] = {}; fr.filter(r => r.quarter === q).forEach(r => { dets.filter(x => x.requestId === r.requestId).forEach(x => { const dept = r.department || 'ไม่ระบุ'; byQuarterDept[q][dept] = (byQuarterDept[q][dept] || 0) + 1; }); }); });
  return JSON.stringify({ fiscalYear: fyN, totalRequests: fr.length, byQuarter: byQ, quarterLabels: Q_LABELS, byDept, byStatus, topItems, lowStock, pendingCount: byStatus['รอดำเนินการ'] || 0, byQuarterDept });
}

function getAvailableFiscalYears() {
  const yrs = [...new Set(rows(SH.REQUESTS).map(r => r.fiscalYear).filter(Boolean))].map(Number);
  yrs.sort((a, b) => b - a);
  if (!yrs.length) yrs.push(fyOf(new Date()));
  return JSON.stringify(yrs);
}

// ══════════════════════════════════════════════════════════
//  ✅ PATCHED v5.2.4: generateRequestPDF
//  — ใช้ DriveApp.getFileById() อ่านโลโก้จาก Drive โดยตรง
//    (UrlFetchApp ดึง Drive thumbnail URL ไม่ได้ เพราะ redirect)
//  — แปลงเป็น base64 data URI ฝังใน HTML → โลโก้ขึ้นใน PDF
//  — ใช้ toThaiDateFull ที่แก้แล้ว (ตัด GMT ออก)
// ══════════════════════════════════════════════════════════
function generateRequestPDF(requestId) {
  const req  = rows(SH.REQUESTS).find(r => r.requestId === requestId);
  const dets = rows(SH.DETAIL).filter(d => d.requestId === requestId);
  if (!req) return JSON.stringify({ success: false, error: 'ไม่พบใบเบิก' });
  const branding = getBrandingObject();

  // ── ✅ PATCH v5.2.4: โหลดโลโก้ด้วย DriveApp.getFileById() ──
  // UrlFetchApp ดึงรูปจาก Drive thumbnail URL ไม่ได้ (redirect/auth)
  // ใช้ DriveApp อ่านไฟล์ตรงๆ แล้วแปลงเป็น base64 data URI ฝังใน PDF
  let logoDataUri = '';
  if (branding.logo_url) {
    try {
      // วิธีที่ 1: ดึง file ID จาก Settings (เร็วสุด)
      let fileId = String(getSettingValue('logo_file_id', '')).trim();

      // วิธีที่ 2: ดึง file ID จาก URL ถ้าไม่มีใน Settings
      if (!fileId) {
        const idMatch = branding.logo_url.match(/[?&]id=([^&]+)/) || branding.logo_url.match(/\/d\/([^/]+)/);
        if (idMatch && idMatch[1]) fileId = idMatch[1];
      }

      if (fileId) {
        // ✅ ใช้ DriveApp อ่านไฟล์โดยตรง — ไม่ต้อง fetch ผ่าน URL
        const logoFile = DriveApp.getFileById(fileId);
        const logoBlob = logoFile.getBlob();
        const b64 = Utilities.base64Encode(logoBlob.getBytes());
        const mimeType = logoBlob.getContentType() || 'image/png';
        logoDataUri = 'data:' + mimeType + ';base64,' + b64;
        Logger.log('✅ Logo loaded from DriveApp, size: ' + b64.length + ' chars');
      } else if (!branding.logo_url.includes('drive.google.com')) {
        // Fallback: ถ้าเป็น URL ภายนอก (ไม่ใช่ Drive) ลอง fetch ปกติ
        const res = UrlFetchApp.fetch(branding.logo_url, { muteHttpExceptions: true, followRedirects: true });
        if (res.getResponseCode() >= 200 && res.getResponseCode() < 300) {
          const blob = res.getBlob();
          logoDataUri = 'data:' + (blob.getContentType() || 'image/png') + ';base64,' + Utilities.base64Encode(blob.getBytes());
        }
      }
    } catch(e) {
      Logger.log('Logo for PDF error: ' + e.message);
    }
  }

  function quarterFull(q) {
    if (!q) return '–';
    const s = String(q);
    if (s.includes('1')) return 'ไตรมาสที่ 1 (ตุลาคม – ธันวาคม)';
    if (s.includes('2')) return 'ไตรมาสที่ 2 (มกราคม – มีนาคม)';
    if (s.includes('3')) return 'ไตรมาสที่ 3 (เมษายน – มิถุนายน)';
    if (s.includes('4')) return 'ไตรมาสที่ 4 (กรกฎาคม – กันยายน)';
    return q;
  }

  const stMap = {
    'อนุมัติ'        : { bg:'#d1fae5',color:'#065f46',border:'#6ee7b7',label:'อนุมัติแล้ว',icon:'✓' },
    'อนุมัติบางส่วน' : { bg:'#fef3c7',color:'#92400e',border:'#fcd34d',label:'อนุมัติบางส่วน',icon:'!' },
    'ปฏิเสธ'         : { bg:'#fee2e2',color:'#991b1b',border:'#fca5a5',label:'ปฏิเสธ',icon:'✗' },
    'รอดำเนินการ'    : { bg:'#dbeafe',color:'#1e40af',border:'#93c5fd',label:'รอดำเนินการ',icon:'○' },
    'ยกเลิก'         : { bg:'#f3f4f6',color:'#374151',border:'#d1d5db',label:'ยกเลิก',icon:'–' }
  };
  const st = stMap[req.status] || stMap['รอดำเนินการ'];
  const totalQtyReq = dets.reduce((s, d) => s + Number(d.qtyRequested), 0);
  const totalQtyApp = dets.reduce((s, d) => s + Number(d.qtyApproved || 0), 0);

  const tableRows = dets.map((d, i) => {
    const qApp = req.status === 'อนุมัติ' ? (d.qtyApproved || d.qtyRequested) : (Number(d.qtyApproved) > 0 ? d.qtyApproved : '–');
    return '<tr style="background:' + (i % 2 === 0 ? '#ffffff' : '#f8fafc') + '">' +
      '<td style="text-align:center;padding:8px 6px;font-size:9pt;color:#9ca3af">' + (i+1) + '</td>' +
      '<td style="padding:8px 10px;font-size:10pt;font-weight:600">' + d.itemName + '</td>' +
      '<td style="text-align:center;padding:8px 6px">' + d.unit + '</td>' +
      '<td style="text-align:center;font-weight:700;color:#1e40af;padding:8px 6px;font-family:monospace">' + d.qtyRequested + '</td>' +
      '<td style="text-align:center;font-weight:700;color:#065f46;padding:8px 6px;font-family:monospace">' + qApp + '</td>' +
      '<td style="font-size:8.5pt;padding:8px 6px;color:#6b7280">' + (d.note||'–') + '</td></tr>';
  }).join('');

  // ── ✅ ใช้ base64 data URI จาก DriveApp ──
  const logoSection = logoDataUri
    ? '<img src="' + logoDataUri + '" style="width:52px;height:52px;border-radius:50%;object-fit:cover" alt="Logo">'
    : '<div style="width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#1e3a5f,#2563eb);display:flex;align-items:center;justify-content:center;font-size:24px;color:#fff">🏛️</div>';

  const html = '<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8">' +
    '<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;600;700;800&display=swap" rel="stylesheet">' +
    '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:\'Sarabun\',sans-serif;font-size:10pt;color:#1f2937;padding:14mm 16mm 18mm 16mm}</style></head><body>' +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:11px;margin-bottom:12px;border-bottom:2px solid #1e3a5f">' +
    '<div style="display:flex;align-items:center;gap:12px">' + logoSection +
    '<div><div style="font-size:14pt;font-weight:800;color:#1e3a5f">' + (branding.org_full_name || branding.org_name || 'หน่วยงาน') + '</div>' +
    '<div style="font-size:8.5pt;color:#4b5563">' + (branding.org_full_subtitle || '') + '</div></div></div>' +
    '<div style="text-align:right"><div style="font-size:16pt;font-weight:800;color:#1e3a5f">ใบเบิกวัสดุ</div>' +
    '<div style="font-size:8.5pt;color:#6b7280">Stock Requisition Form</div></div></div>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:7px;padding:8px 14px;margin-bottom:12px">' +
    '<div><div style="font-size:7.5pt;color:#4b5563;font-weight:700">เลขที่ใบเบิก</div>' +
    '<div style="font-family:monospace;font-size:12pt;font-weight:700;color:#1e3a5f">' + req.requestId + '</div></div>' +
    '<div style="display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:5px;font-size:9.5pt;font-weight:700;background:' + st.bg + ';color:' + st.color + ';border:1.5px solid ' + st.border + '">' + st.label + '</div>' +
    '<div style="text-align:right;font-size:7pt;color:#9ca3af">พิมพ์: ' + nowThai() + '<br>ปีงบ พ.ศ. ' + req.fiscalYear + ' · ' + quarterFull(req.quarter) + '</div></div>' +
    '<table style="width:100%;border-collapse:collapse;border:1.5px solid #e5e7eb;border-radius:6px;margin-bottom:12px;font-size:9.5pt">' +
    '<tr><td style="background:#f8fafc;padding:6px 12px;font-weight:700;width:22%;border:1px solid #f3f4f6">ผู้ขอเบิกวัสดุ</td><td style="padding:6px 12px;font-weight:600;border:1px solid #f3f4f6">' + req.requesterName + '</td><td style="background:#f8fafc;padding:6px 12px;font-weight:700;width:22%;border:1px solid #f3f4f6">หน่วยงาน</td><td style="padding:6px 12px;border:1px solid #f3f4f6">' + req.department + '</td></tr>' +
    '<tr><td style="background:#f8fafc;padding:6px 12px;font-weight:700;border:1px solid #f3f4f6">วัตถุประสงค์</td><td colspan="3" style="padding:6px 12px;border:1px solid #f3f4f6">' + (req.purpose||'–') + '</td></tr>' +
    '<tr><td style="background:#f8fafc;padding:6px 12px;font-weight:700;border:1px solid #f3f4f6">วันที่ยื่นคำขอ</td><td style="padding:6px 12px;border:1px solid #f3f4f6">' + toThaiDateFull(req.requestDate) + '</td><td style="background:#f8fafc;padding:6px 12px;font-weight:700;border:1px solid #f3f4f6">ปีงบ / ไตรมาส</td><td style="padding:6px 12px;border:1px solid #f3f4f6">พ.ศ. ' + req.fiscalYear + ' · ' + quarterFull(req.quarter) + '</td></tr>' +
    (req.approvedBy ? '<tr><td style="background:#f8fafc;padding:6px 12px;font-weight:700;border:1px solid #f3f4f6">ผู้อนุมัติ</td><td style="padding:6px 12px;border:1px solid #f3f4f6">' + req.approvedBy + '</td><td style="background:#f8fafc;padding:6px 12px;font-weight:700;border:1px solid #f3f4f6">วันที่อนุมัติ</td><td style="padding:6px 12px;border:1px solid #f3f4f6">' + toThaiDateFull(req.approvedAt) + '</td></tr>' : '') +
    '</table>' +
    (req.rejReason ? '<div style="background:#fef2f2;border-left:4px solid #ef4444;padding:8px 12px;border-radius:0 5px 5px 0;margin-bottom:10px;font-size:9pt;color:#991b1b"><strong>เหตุผลการปฏิเสธ:</strong> ' + req.rejReason + '</div>' : '') +
    '<div style="background:linear-gradient(90deg,#1e3a5f,#1e40af);padding:8px 14px;border-radius:6px 6px 0 0;display:flex;justify-content:space-between">' +
    '<span style="color:#fff;font-size:10pt;font-weight:800">รายการวัสดุที่ขอเบิก</span>' +
    '<span style="color:rgba(255,255,255,.75);font-size:8pt">' + dets.length + ' รายการ · รวม ' + totalQtyReq + ' หน่วย</span></div>' +
    '<table style="width:100%;border-collapse:collapse;border:1.5px solid #cbd5e1;border-top:none"><thead><tr style="background:#f1f5f9">' +
    '<th style="padding:7px 10px;font-size:8pt;border-bottom:2.5px solid #1e3a5f;border-right:1px solid #e2e8f0;text-align:center">ลำดับ</th>' +
    '<th style="padding:7px 10px;font-size:8pt;border-bottom:2.5px solid #1e3a5f;border-right:1px solid #e2e8f0;text-align:left">ชื่อวัสดุ</th>' +
    '<th style="padding:7px 10px;font-size:8pt;border-bottom:2.5px solid #1e3a5f;border-right:1px solid #e2e8f0;text-align:center">หน่วย</th>' +
    '<th style="padding:7px 10px;font-size:8pt;border-bottom:2.5px solid #1e3a5f;border-right:1px solid #e2e8f0;text-align:center">จำนวนขอ</th>' +
    '<th style="padding:7px 10px;font-size:8pt;border-bottom:2.5px solid #1e3a5f;border-right:1px solid #e2e8f0;text-align:center">อนุมัติ</th>' +
    '<th style="padding:7px 10px;font-size:8pt;border-bottom:2.5px solid #1e3a5f;text-align:left">หมายเหตุ</th>' +
    '</tr></thead><tbody>' + tableRows + '</tbody></table>' +
    '<div style="background:#f8fafc;border:1.5px solid #cbd5e1;border-top:2.5px solid #1e3a5f;padding:7px 14px;display:flex;justify-content:flex-end;gap:24px;margin-bottom:16px">' +
    '<span style="color:#6b7280;font-size:8.5pt">รวมรายการ</span><strong style="font-family:monospace;color:#1e40af">' + dets.length + '</strong>' +
    '<span style="color:#6b7280;font-size:8.5pt">รวมจำนวนขอ</span><strong style="font-family:monospace;color:#1e40af">' + totalQtyReq + '</strong>' +
    (totalQtyApp > 0 ? '<span style="color:#6b7280;font-size:8.5pt">รวมอนุมัติ</span><strong style="font-family:monospace;color:#065f46">' + totalQtyApp + '</strong>' : '') + '</div>' +
   + '<div style="margin-top:16px;border-top:1.5px solid #e5e7eb;padding-top:14px">'
    + '<div style="text-align:center;font-size:8.5pt;color:#6b7280;margin-bottom:12px">— ลายมือชื่อผู้เกี่ยวข้อง —</div>'
    + '<table style="width:100%;border-collapse:collapse">'
    + '<tr>'
    + '<td style="width:33%;text-align:center;padding:0 10px">'
    + '<div style="background:#f5f7ff;border:1px solid #c5cae9;border-radius:5px;padding:5px 10px;font-size:9pt;font-weight:700;color:#283593;margin-bottom:12px">ผู้ขอเบิกวัสดุ</div>'
    + '<div style="height:50px;border-bottom:1.5px solid #424242;margin-bottom:8px"></div>'
    + '<div style="font-size:10pt;font-weight:600;color:#1a1a2e">' + req.requesterName + '</div>'
    + '<div style="font-size:9pt;color:#757575">' + req.department + '</div>'
    + '</td>'
    + '<td style="width:33%;text-align:center;padding:0 10px">'
    + '<div style="background:#f5f7ff;border:1px solid #c5cae9;border-radius:5px;padding:5px 10px;font-size:9pt;font-weight:700;color:#283593;margin-bottom:12px">เจ้าหน้าที่พัสดุ</div>'
    + '<div style="height:50px;border-bottom:1.5px solid #424242;margin-bottom:8px"></div>'
    + '<div style="font-size:10pt;font-weight:600;color:#1a1a2e">' + (req.approvedBy || '&nbsp;') + '</div>'
    + '</td>'
    + '<td style="width:33%;text-align:center;padding:0 10px">'
    + '<div style="background:#f5f7ff;border:1px solid #c5cae9;border-radius:5px;padding:5px 10px;font-size:9pt;font-weight:700;color:#283593;margin-bottom:12px">ผู้อนุมัติ</div>'
    + '<div style="height:50px;border-bottom:1.5px solid #424242;margin-bottom:8px"></div>'
    + '<div style="font-size:10pt;font-weight:600;color:#1a1a2e">&nbsp;</div>'
    + '</td>'
    + '</tr>'
    + '</table>'
    + '</div>'
    + '</body></html>';

  try {
    const tmp = DriveApp.createFile(Utilities.newBlob(html, 'text/html', 'tmp_req.html'));
    const pdf = DriveApp.createFile(tmp.getAs('application/pdf').setName('ใบเบิกวัสดุ_' + requestId + '.pdf'));
    tmp.setTrashed(true);
    pdf.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return JSON.stringify({ success: true, url: 'https://drive.google.com/file/d/' + pdf.getId() + '/view', downloadUrl: pdf.getDownloadUrl() });
  } catch(e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

// ══════════════════════════════════════════════════════════
//  Admin Submit Request (ย้อนหลัง)
// ══════════════════════════════════════════════════════════

function adminSubmitRequest(json) {
  try {
    const p = JSON.parse(json);
    function parseThaiDate(str) {
      if (!str) return new Date();
      const parts = String(str).trim().split('/');
      if (parts.length === 3) {
        const d = parseInt(parts[0], 10); const m = parseInt(parts[1], 10) - 1;
        let y  = parseInt(parts[2], 10);
        if (y > 2400) y -= 543;
        return new Date(y, m, d);
      }
      return new Date(str);
    }
    const reqDate = parseThaiDate(p.requestDate);
    const fiscalYear = fyOf(reqDate);
    const quarter    = qOf(reqDate);
    const deptCode = (p.department || 'GEN').replace(/[^a-zA-Zก-ฮ]/g, '').substring(0, 3).toUpperCase();
    const existing = rows(SH.REQUESTS).filter(r => String(r.fiscalYear) === String(fiscalYear));
    const reqId = fiscalYear + '-' + deptCode + '-' + String(existing.length + 1).padStart(4, '0');
    const dd   = String(reqDate.getDate()).padStart(2, '0');
    const mm   = String(reqDate.getMonth() + 1).padStart(2, '0');
    const yyyy = reqDate.getFullYear();
    const displayDate = dd + '/' + mm + '/' + yyyy + ' 00:00';

    const req = { requestId: reqId, requestDate: displayDate, requesterName: p.requesterName, department: p.department, purpose: p.purpose, status: 'รอดำเนินการ', totalItems: (p.items || []).length, note: p.note || '[Admin บันทึกย้อนหลัง]', createdAt: new Date().toISOString(), fiscalYear: fiscalYear, quarter: quarter, approvedBy: '', approvedAt: '', rejReason: '' };
    addRow(SH.REQUESTS, req);

    const dets = [];
    (p.items || []).forEach((it, i) => {
      const det = { detailId: reqId + '_' + String(i + 1).padStart(2, '0'), requestId: reqId, itemId: it.id || '', itemName: it.name || it.itemName || '', unit: it.unit || '', qtyRequested: it.qty || it.qtyRequested || 0, qtyApproved: 0, note: it.note || '' };
      addRow(SH.DETAIL, det); dets.push(det);
    });

    const users = rows(SH.USERS);
    const u = users.find(x => x.name === p.requesterName && x.department === p.department);
    if (u) { setRow(SH.USERS, 'userId', u.userId, { totalRequests: (Number(u.totalRequests) || 0) + 1 }); }

    return JSON.stringify({ success: true, requestId: reqId, fiscalYear: fiscalYear, quarter: quarter, requestDate: displayDate });
  } catch (err) { return JSON.stringify({ success: false, error: err.message }); }
}

// ══════════════════════════════════════════════════════════
//  Reset Password
// ══════════════════════════════════════════════════════════

function forceResetAdminPassword() {
  initSheets();
  saveSettingValue('admin_password', '123456');
  return JSON.stringify({ success: true, password: '123456' });
}

function getUserNames() {
  try {
    const users = rows(SH.USERS);
    const result = users
      .filter(u => u.isActive !== false && u.isActive !== 'false')
      .map(u => ({
        name       : String(u.name       || '').trim(),
        department : String(u.department || '').trim(),
      }))
      .filter(u => u.name);
    return JSON.stringify(result);
  } catch(e) {
    return JSON.stringify([]);
  }
}
function updateUserActivity(userId) {
  const sh = ss().getSheetByName('Users');
  if (!sh) return;
  
  const data = sh.getDataRange().getValues();
  const headers = data[0].map(h => String(h || '').trim());
  const idCol = headers.indexOf('userId');
  let actCol = headers.indexOf('lastActivity');
  const loginCol = headers.indexOf('lastLogin');
  
  if (idCol < 0) return;
  
  // ถ้ายังไม่มีคอลัมน์ lastActivity → สร้างใหม่
  if (actCol < 0) {
    actCol = headers.length;
    sh.getRange(1, actCol + 1).setValue('lastActivity');
  }
  
  const now = new Date();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]).trim() === String(userId).trim()) {
      sh.getRange(i + 1, actCol + 1).setValue(now);
      if (loginCol >= 0) sh.getRange(i + 1, loginCol + 1).setValue(now);
      break;
    }
  }
}
function createRichMenu() {
  const token = _getLineChannelToken();
  if (!token) { Logger.log('ไม่พบ Token'); return; }

  // ── 1. สร้าง Rich Menu ──
  const menu = {
    size: { width: 2500, height: 843 },
    selected: true,
    name: 'ระบบเบิกวัสดุ',
    chatBarText: '📋 เมนูระบบเบิกวัสดุ',
    areas: [
      {
        bounds: { x: 0, y: 0, width: 833, height: 843 },
        action: { type: 'message', label: '📋 สถานะใบเบิก', text: 'สถานะ' }
      },
      {
        bounds: { x: 833, y: 0, width: 834, height: 843 },
        action: { type: 'message', label: '⚠️ ของใกล้หมด', text: 'ของใกล้หมด' }
      },
      {
        bounds: { x: 1667, y: 0, width: 833, height: 843 },
        action: { type: 'message', label: '🆔 ดู ID ของฉัน', text: 'ID' }
      }
    ]
  };

  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(menu),
    muteHttpExceptions: true
  });

  const result = JSON.parse(res.getContentText());
  Logger.log('Rich Menu ID: ' + JSON.stringify(result));

  if (!result.richMenuId) {
    Logger.log('สร้าง Rich Menu ล้มเหลว: ' + JSON.stringify(result));
    return;
  }

  const richMenuId = result.richMenuId;

  // ── 2. อัปโหลดรูป Rich Menu ──
  // สร้างรูปอย่างง่ายด้วย HTML → PDF → ไม่ได้ใช้วิธีนี้
  // ใช้วิธีอัปโหลดรูปจาก URL แทน
  const imgRes = uploadRichMenuImage(richMenuId, token);
  Logger.log('Upload image: ' + imgRes);

  // ── 3. ตั้งเป็น Default Rich Menu ──
  const setRes = UrlFetchApp.fetch(
    'https://api.line.me/v2/bot/user/all/richmenu/' + richMenuId,
    {
      method: 'post',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    }
  );
  Logger.log('Set default: ' + setRes.getResponseCode());
  Logger.log('✅ Rich Menu สร้างสำเร็จ! ID: ' + richMenuId);
}

function uploadRichMenuImage(richMenuId, token) {
  // ── สร้างรูป Rich Menu ด้วย HTML ──
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@700;800&display=swap" rel="stylesheet">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  width: 2500px; height: 843px;
  font-family: 'Sarabun', sans-serif;
  background: #1a0a00;
  display: flex;
}
.cell {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  border-right: 2px solid rgba(255,255,255,0.12);
  cursor: pointer;
  transition: background 0.2s;
}
.cell:last-child { border-right: none; }
.cell:nth-child(1) { background: linear-gradient(160deg, #c94d00, #e85d04); }
.cell:nth-child(2) { background: linear-gradient(160deg, #991b1b, #dc2626); }
.cell:nth-child(3) { background: linear-gradient(160deg, #1e3a5f, #2563eb); }
.icon { font-size: 120px; line-height: 1; }
.label {
  font-size: 60px;
  font-weight: 800;
  color: #ffffff;
  text-shadow: 0 3px 12px rgba(0,0,0,0.4);
  text-align: center;
  padding: 0 20px;
  line-height: 1.3;
}
.sub {
  font-size: 38px;
  color: rgba(255,255,255,0.72);
  font-weight: 600;
  text-align: center;
}
</style>
</head>
<body>
  <div class="cell">
    <span class="icon">📋</span>
    <div class="label">สถานะใบเบิก</div>
    <div class="sub">พิมพ์: สถานะ</div>
  </div>
  <div class="cell">
    <span class="icon">⚠️</span>
    <div class="label">วัสดุใกล้หมด</div>
    <div class="sub">พิมพ์: ของใกล้หมด</div>
  </div>
  <div class="cell">
    <span class="icon">🆔</span>
    <div class="label">ดู ID ของฉัน</div>
    <div class="sub">พิมพ์: ID</div>
  </div>
</body>
</html>`;

  // แปลง HTML → PDF → Blob
  const blob = Utilities.newBlob(html, 'text/html', 'richmenu.html');
  const file = DriveApp.createFile(blob);
  const pdfBlob = file.getAs('application/pdf');
  file.setTrashed(true);

  // ⚠️ LINE ต้องการ JPEG ขนาด 2500×843 — ต้องอัปโหลดรูปที่ถูกต้อง
  // วิธีนี้ใช้รูป placeholder ก่อน แล้วไปอัปโหลดรูปจริงใน OA Manager
  Logger.log('⚠️ กรุณาอัปโหลดรูป Rich Menu ใน LINE OA Manager ด้วยตนเอง');
  Logger.log('Rich Menu ID: ' + richMenuId);
  return 'กรุณาอัปโหลดรูปด้วยตนเองที่ LINE OA Manager';
}

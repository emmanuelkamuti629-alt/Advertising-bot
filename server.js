require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const AfricasTalking = require('africastalking');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== Africa's Talking SMS ==========
const at = AfricasTalking({
  username: process.env.AT_USERNAME,
  apiKey: process.env.AT_API_KEY
});
const sms = at.SMS;

// ========== In-memory message records ==========
const messageLog = [];

// ========== WhatsApp Cloud API send ==========
async function sendWhatsApp(to, body) {
  const cleanTo = to.replace(/\D/g, '');
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v20.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: cleanTo,
        type: 'text',
        text: { body }
      },
      { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` } }
    );
    return { success: true, wamid: res.data.messages[0].id };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.error?.message || err.message
    };
  }
}

// ========== WhatsApp number pre-check (Wassenger) ==========
async function checkWhatsAppNumber(phone) {
  try {
    const { verifyPhoneNumber } = await import('whatsapp-number-verify');
    const result = await verifyPhoneNumber(phone, {
      apiToken: process.env.WASSENGER_API_TOKEN
    });
    return { exists: result.exists, phone: result.phone };
  } catch (err) {
    return { exists: null, error: err.message };
  }
}

// ========== Routes ==========

app.post('/api/check-whatsapp', async (req, res) => {
  const { phones } = req.body;
  if (!Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ error: 'Phones array required' });
  }
  const results = [];
  for (const phone of phones) {
    const r = await checkWhatsAppNumber(phone);
    results.push({ phone, ...r });
    await new Promise(r => setTimeout(r, 1200));
  }
  res.json({ results });
});

app.post('/api/send-sms', async (req, res) => {
  const { phones, message } = req.body;
  if (!Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ error: 'Phones array required' });
  }
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message required' });
  }
  const results = [];
  for (const phone of phones) {
    const normalized = phone.replace(/\s/g, '');
    try {
      const response = await sms.send({
        to: [normalized],
        message: message,
        senderId: process.env.AT_SENDER_ID
      });
      const recipient = response.SMSMessageData?.Recipients?.[0];
      const ok = recipient?.status === 'Success';
      const record = {
        id: recipient?.messageId || `sms_${Date.now()}_${Math.random()}`,
        phone: normalized,
        channel: 'SMS',
        message: message.substring(0, 50),
        status: ok ? 'sent' : 'failed',
        error: ok ? null : (recipient?.status || 'Unknown'),
        timestamp: new Date().toISOString()
      };
      messageLog.push(record);
      results.push(record);
    } catch (err) {
      const record = {
        id: `sms_err_${Date.now()}`,
        phone: normalized,
        channel: 'SMS',
        message: message.substring(0, 50),
        status: 'failed',
        error: err.message,
        timestamp: new Date().toISOString()
      };
      messageLog.push(record);
      results.push(record);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  res.json({ results });
});

app.post('/api/send-whatsapp', async (req, res) => {
  const { phones, message } = req.body;
  if (!Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ error: 'Phones array required' });
  }
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message required' });
  }
  const results = [];
  for (const phone of phones) {
    const normalized = phone.replace(/\s/g, '');
    const waResult = await sendWhatsApp(normalized, message);
    const record = {
      id: waResult.success ? waResult.wamid : `wa_err_${Date.now()}`,
      phone: normalized,
      channel: 'WhatsApp',
      message: message.substring(0, 50),
      status: waResult.success ? 'accepted' : 'failed',
      error: waResult.error || null,
      timestamp: new Date().toISOString()
    };
    messageLog.push(record);
    results.push(record);
    await new Promise(r => setTimeout(r, 500));
  }
  res.json({ results });
});

app.get('/api/messages', (req, res) => {
  res.json(messageLog.slice().reverse());
});

// ========== WhatsApp Webhook ==========
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    body.entry?.forEach(entry => {
      entry.changes?.forEach(change => {
        const statuses = change.value?.statuses;
        if (statuses) {
          statuses.forEach(s => {
            const record = messageLog.find(m => m.id === s.id);
            if (record) {
              record.status = s.status;
              if (s.errors) {
                record.error = s.errors[0]?.title || s.errors[0]?.code;
              }
            }
          });
        }
      });
    });
  }
  res.sendStatus(200);
});

// ========== Start ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

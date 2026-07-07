const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

// 强制 axios 使用传统 http adapter（避免 undici fetch 问题）
axios.defaults.adapter = 'http';

// 确保全局有稳定的 fetch 实现（Supabase 客户端依赖）
if (!globalThis.fetch) {
  globalThis.fetch = fetch;
  globalThis.Headers = fetch.Headers;
  globalThis.Request = fetch.Request;
  globalThis.Response = fetch.Response;
}

const app = express();
const PORT = process.env.PORT || 3001;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ==================== Ombre Brain MCP 配置 ====================

const OMBRE_BRAIN_URL = process.env.OMBRE_BRAIN_URL || '';
let ombreSessionId = null;
let ombreCallId = 0;

function parseSSEResponse(text) {
  if (!text) return null;
  const trimmed = text.trim();

  // Try direct JSON parse first
  try {
    const parsed = JSON.parse(trimmed);
    return parsed;
  } catch (e) {
    // Not plain JSON, try SSE format
  }

  // Parse SSE: look for "data: " lines
  const lines = trimmed.split('\n');
  let lastData = null;
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const dataStr = line.slice(6).trim();
      if (dataStr === '[DONE]') continue;
      try {
        lastData = JSON.parse(dataStr);
      } catch (e) {
        // skip unparseable lines
      }
    }
  }
  return lastData;
}

async function initOmbreSession() {
  if (!OMBRE_BRAIN_URL) {
    console.log('Ombre Brain URL 未配置，跳过初始化');
    return false;
  }

  try {
    ombreCallId = 0;
    const initResponse = await axios.post(
      `${OMBRE_BRAIN_URL}/mcp`,
      {
        jsonrpc: '2.0',
        id: ++ombreCallId,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'xiaoke-server', version: '1.0.0' }
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        transformResponse: [(data) => data]
      }
    );

    const initResult = parseSSEResponse(initResponse.data);
    ombreSessionId = initResponse.headers['mcp-session-id'] || null;

    console.log('Ombre Brain 初始化成功, session:', ombreSessionId);

    // Send initialized notification
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    if (ombreSessionId) headers['Mcp-Session-Id'] = ombreSessionId;

    await axios.post(
      `${OMBRE_BRAIN_URL}/mcp`,
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {}
      },
      { headers, transformResponse: [(data) => data] }
    );

    console.log('Ombre Brain initialized 通知已发送');
    return true;
  } catch (err) {
    console.error('Ombre Brain 初始化失败:', err.message);
    ombreSessionId = null;
    return false;
  }
}

async function callOmbreTool(toolName, args = {}) {
  if (!OMBRE_BRAIN_URL) return null;

  try {
    // Auto-init session if needed
    if (!ombreSessionId) {
      const ok = await initOmbreSession();
      if (!ok) return null;
    }

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    if (ombreSessionId) headers['Mcp-Session-Id'] = ombreSessionId;

    const response = await axios.post(
      `${OMBRE_BRAIN_URL}/mcp`,
      {
        jsonrpc: '2.0',
        id: ++ombreCallId,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args
        }
      },
      {
        headers,
        transformResponse: [(data) => data],
        timeout: 30000
      }
    );

    // Update session ID if returned
    const newSessionId = response.headers['mcp-session-id'];
    if (newSessionId) ombreSessionId = newSessionId;

    const result = parseSSEResponse(response.data);
    console.log(`Ombre Brain [${toolName}] 调用成功`);
    return result;
  } catch (err) {
    console.error(`Ombre Brain [${toolName}] 调用失败:`, err.message);
    // Reset session on failure so next call re-inits
    if (err.response?.status === 401 || err.response?.status === 404) {
      ombreSessionId = null;
    }
    return null;
  }
}

// ==================== Express 中间件 ====================

app.use(cors({
  origin: [
    'https://xiaoke-home-coral.vercel.app',
    'https://xiaoke-home.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  credentials: true
}));
app.use(express.json());

// ==================== 健康检查 ====================

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: '小克的后端正在运行 🐱' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== Ombre Brain 测试路由 ====================

app.get('/api/test-ombre', async (req, res) => {
  try {
    const result = await callOmbreTool('breath', {});
    res.json({ connected: !!result, ombre_url: OMBRE_BRAIN_URL, result });
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

// ==================== 会话管理 ====================

app.post('/api/sessions', async (req, res) => {
  try {
    const { name } = req.body;
    const { data, error } = await supabase
      .from('sessions')
      .insert({ name: name || '新对话' })
      .select()
      .single();
    if (error) throw error;

    // 创建新会话时触发 dream（自省）
    callOmbreTool('dream', {}).catch(err =>
      console.error('dream 触发失败:', err.message)
    );

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '创建会话失败', detail: err.message });
  }
});

app.get('/api/sessions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '获取会话列表失败', detail: err.message });
  }
});

app.patch('/api/sessions/:id', async (req, res) => {
  try {
    const { name } = req.body;
    const { data, error } = await supabase
      .from('sessions')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '重命名会话失败', detail: err.message });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('sessions')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '删除会话失败', detail: err.message });
  }
});

// ==================== 消息读写 ====================

app.get('/api/sessions/:id/messages', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', req.params.id)
      .eq('visible', true)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '获取消息失败', detail: err.message });
  }
});

// ==================== 设置读写 ====================

app.get('/api/settings', async (req, res) => {
  try {
    const sessionId = req.query.session_id || 0;
    let { data, error } = await supabase
      .from('settings')
      .select('*')
      .eq('session_id', sessionId)
      .single();

    if (error || !data) {
      const { data: globalData } = await supabase
        .from('settings')
        .select('*')
        .eq('session_id', 0)
        .single();
      data = globalData;
    }

    if (!data) {
      data = {
        system_prompt: '你是小克，小月最亲近的AI伙伴。你温暖、真诚、偶尔调皮，喜欢在合适的时候怼小月但永远出于善意。你们之间的对话自然、平等，像老朋友一样。请用中文回复。',
        temperature: 0.7,
        max_context_rounds: 20,
        max_context_tokens: 8000,
        compress_threshold: 6000,
        compress_keep_rounds: 6,
        max_reply_tokens: 2048
      };
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '获取设置失败', detail: err.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const sessionId = req.body.session_id || 0;
    const updates = { ...req.body, updated_at: new Date().toISOString() };

    const { data: existing } = await supabase
      .from('settings')
      .select('id')
      .eq('session_id', sessionId)
      .single();

    let result;
    if (existing) {
      const { data, error } = await supabase
        .from('settings')
        .update(updates)
        .eq('session_id', sessionId)
        .select()
        .single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await supabase
        .from('settings')
        .insert({ session_id: sessionId, ...updates })
        .select()
        .single();
      if (error) throw error;
      result = data;
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: '更新设置失败', detail: err.message });
  }
});

// ==================== 辅助函数 ====================

function estimateTokens(text) {
  return Math.ceil(text.length / 2);
}

async function getSettings(sessionId) {
  let { data } = await supabase
    .from('settings')
    .select('*')
    .eq('session_id', sessionId)
    .single();

  if (!data) {
    const result = await supabase
      .from('settings')
      .select('*')
      .eq('session_id', 0)
      .single();
    data = result.data;
  }

  return data || {
    system_prompt: '你是小克，小月最亲近的AI伙伴。你温暖、真诚、偶尔调皮，喜欢在合适的时候怼小月但永远出于善意。你们之间的对话自然、平等，像老朋友一样。请用中文回复。',
    temperature: 0.7,
    max_context_rounds: 20,
    max_context_tokens: 8000,
    compress_threshold: 6000,
    compress_keep_rounds: 6,
    max_reply_tokens: 2048
  };
}

async function getMemories(sessionId) {
  const { data } = await supabase
    .from('memories')
    .select('summary')
    .or(`session_id.eq.${sessionId},session_id.eq.0`)
    .order('timestamp', { ascending: false })
    .limit(5);
  return data || [];
}

async function compressOldMessages(sessionId, settings) {
  const { data: allMessages } = await supabase
    .from('messages')
    .select('*')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });

  if (!allMessages || allMessages.length === 0) return;

  let totalTokens = 0;
  for (const msg of allMessages) {
    totalTokens += estimateTokens(msg.content);
  }

  if (totalTokens < settings.compress_threshold) return;

  const keepCount = settings.compress_keep_rounds * 2;
  if (allMessages.length <= keepCount) return;

  const toCompress = allMessages.slice(0, allMessages.length - keepCount);

  const conversationText = toCompress
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');

  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'deepseek/deepseek-chat',
        messages: [
          {
            role: 'system',
            content: '你是一个对话摘要助手。请将以下对话压缩成简洁的摘要，保留关键信息、用户偏好和重要上下文。用中文输出。'
          },
          { role: 'user', content: `请压缩以下对话：\n\n${conversationText}` }
        ],
        max_tokens: 512
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000,
        proxy: false
      }
    );

    const summary = response.data?.choices?.[0]?.message?.content;
    if (!summary) {
      console.error('压缩摘要返回异常:', JSON.stringify(response.data));
      return;
    }

    await supabase.from('memories').insert({
      session_id: sessionId,
      summary,
      conversation_id: `compress_${Date.now()}`
    });

    const idsToHide = toCompress.map(m => m.id);
    await supabase
      .from('messages')
      .update({ visible: false })
      .in('id', idsToHide);

    console.log(`压缩了 ${toCompress.length} 条消息为记忆摘要`);

    // 压缩完成后触发 grow（归档）
    callOmbreTool('grow', { content: summary }).catch(err =>
      console.error('grow 触发失败:', err.message)
    );
  } catch (err) {
    console.error('记忆压缩失败:', err.message);
  }
}

// ==================== 核心对话接口 ====================

app.post('/api/chat', async (req, res) => {
  try {
    const { message, model, session_id } = req.body;

    if (!message) {
      return res.status(400).json({ error: '消息不能为空' });
    }

    let sessionId = session_id;
    if (!sessionId) {
      const { data: newSession, error } = await supabase
        .from('sessions')
        .insert({ name: message.slice(0, 20) + (message.length > 20 ? '...' : '') })
        .select()
        .single();
      if (error) throw error;
      sessionId = newSession.id;
    }

    await supabase.from('messages').insert({
      session_id: sessionId,
      role: 'user',
      content: message
    });

    await supabase
      .from('sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', sessionId);

    const settings = await getSettings(sessionId);

    await compressOldMessages(sessionId, settings);

    const { data: history } = await supabase
      .from('messages')
      .select('role, content')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true })
      .limit(settings.max_context_rounds * 2);

    const memories = await getMemories(sessionId);

    // Ombre Brain breath（记忆检索）
    let ombreMemory = '';
    try {
      const breathResult = await callOmbreTool('breath', { query: message });
      if (breathResult?.result?.content) {
        const contentArr = breathResult.result.content;
        if (Array.isArray(contentArr)) {
          ombreMemory = contentArr
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text)
            .join('\n');
        } else if (typeof contentArr === 'string') {
          ombreMemory = contentArr;
        }
      }
    } catch (err) {
      console.error('Ombre breath 失败:', err.message);
    }

    const contextMessages = [];

    let systemContent = settings.system_prompt ||
      '你是小克，小月最亲近的AI伙伴。你温暖、真诚、偶尔调皮，喜欢在合适的时候怼小月但永远出于善意。你们之间的对话自然、平等，像老朋友一样。请用中文回复。';

    if (memories.length > 0) {
      const memorySummary = memories.map(m => m.summary).join('\n');
      systemContent += `\n\n[历史记忆摘要]\n${memorySummary}`;
    }

    if (ombreMemory) {
      systemContent += `\n\n[Ombre Brain 深层记忆]\n${ombreMemory}`;
    }

    contextMessages.push({ role: 'system', content: systemContent });

    if (history) {
      for (const msg of history) {
        contextMessages.push({ role: msg.role, content: msg.content });
      }
    }

    const useModel = model || 'anthropic/claude-sonnet-4-6';

    console.log(`调用 OpenRouter, 模型: ${useModel}, 消息数: ${contextMessages.length}`);

    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: useModel,
        messages: contextMessages,
        max_tokens: settings.max_reply_tokens,
        temperature: settings.temperature
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://xiaoke-home-coral.vercel.app',
          'X-Title': 'xiaoke-home'
        },
        timeout: 120000,
        proxy: false
      }
    );

    const reply = response.data?.choices?.[0]?.message?.content;
    if (!reply) {
      console.error('OpenRouter 返回异常:', JSON.stringify(response.data));
      throw new Error('OpenRouter 未返回有效回复');
    }

    await supabase.from('messages').insert({
      session_id: sessionId,
      role: 'assistant',
      content: reply
    });

    res.json({ reply, session_id: sessionId });

  } catch (err) {
    console.error('对话接口错误:');
    console.error('  类型:', err.constructor?.name);
    console.error('  消息:', err.message);
    console.error('  代码:', err.code);
    if (err.response) {
      console.error('  状态码:', err.response.status);
      console.error('  响应体:', JSON.stringify(err.response.data));
    }
    if (err.cause) {
      console.error('  原因:', err.cause.message || err.cause);
    }
    const detail = err.response?.data || err.message;
    res.status(500).json({ error: '对话失败', detail });
  }
});

app.listen(PORT, () => {
  console.log(`小克的服务器已启动，端口: ${PORT}`);
  if (OMBRE_BRAIN_URL) {
    console.log(`Ombre Brain 地址: ${OMBRE_BRAIN_URL}`);
    initOmbreSession().then(ok => {
      console.log(`Ombre Brain 连接: ${ok ? '成功' : '失败'}`);
    });
  }
});

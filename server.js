const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { createClient } = require('@supabase/supabase-js');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

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

// ==================== 表情包 ====================

app.get('/api/stickers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('stickers')
      .select('*')
      .order('id', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '获取表情包失败', detail: err.message });
  }
});

app.post('/api/stickers', async (req, res) => {
  try {
    const { filename } = req.body;
    let { label } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename 不能为空' });

    // 没给标签时用视觉模型自动生成
    if (!label) {
      try {
        const imageUrl = filename.startsWith('http')
          ? filename
          : `https://xiaoke-home-coral.vercel.app${filename}`;
        const visionRes = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: 'anthropic/claude-haiku-4.5',
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: '用10个字以内描述这个表情包表达的情绪或动作，只输出描述本身。' },
                { type: 'image_url', image_url: { url: imageUrl } }
              ]
            }],
            max_tokens: 50
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
        label = visionRes.data?.choices?.[0]?.message?.content?.trim() || '表情';
      } catch (e) {
        console.error('表情标签生成失败:', e.message);
        label = '表情';
      }
    }

    const { data, error } = await supabase
      .from('stickers')
      .insert({ filename, label })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '添加表情包失败', detail: err.message });
  }
});

app.delete('/api/stickers/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('stickers').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '删除表情包失败', detail: err.message });
  }
});

// ==================== 记忆库 ====================

app.get('/api/memories', async (req, res) => {
  try {
    let query = supabase
      .from('memories')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(100);
    if (req.query.date) {
      const day = req.query.date; // YYYY-MM-DD
      query = query.gte('timestamp', `${day}T00:00:00`).lt('timestamp', `${day}T23:59:59`);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '获取记忆失败', detail: err.message });
  }
});

app.get('/api/memories/buckets', async (req, res) => {
  try {
    const result = await callOmbreTool('pulse', { include_archive: false });
    let text = '';
    const content = result?.result?.content;
    if (Array.isArray(content)) {
      text = content.filter(c => c.type === 'text' && c.text).map(c => c.text).join('\n');
    }
    res.json({ connected: !!result, raw: text });
  } catch (err) {
    res.status(500).json({ error: '获取记忆桶失败', detail: err.message });
  }
});

app.get('/api/memories/:id/comments', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('comments')
      .select('*')
      .eq('memory_id', req.params.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '获取评论失败', detail: err.message });
  }
});

app.post('/api/memories/:id/comments', async (req, res) => {
  try {
    const memoryId = req.params.id;
    const { content, ai } = req.body;

    let finalContent = content;
    let author = '小月';

    if (ai) {
      // 让小克对这条记忆说一句话
      const { data: memory } = await supabase
        .from('memories')
        .select('summary')
        .eq('id', memoryId)
        .single();
      if (!memory) return res.status(404).json({ error: '记忆不存在' });

      const settings = await getSettings(0);
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'anthropic/claude-sonnet-4-6',
          messages: [
            { role: 'system', content: settings.system_prompt || '你是小克。' },
            { role: 'user', content: `这是我们的一段回忆：\n\n${memory.summary}\n\n请用一两句话评论这段回忆，像翻旧照片时随口说的那种感觉，温暖自然。` }
          ],
          max_tokens: 200
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
      finalContent = response.data?.choices?.[0]?.message?.content;
      author = '小克';
      if (!finalContent) throw new Error('AI 评论生成失败');
    }

    if (!finalContent) return res.status(400).json({ error: '评论内容不能为空' });

    const { data, error } = await supabase
      .from('comments')
      .insert({ memory_id: memoryId, author, content: finalContent })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '添加评论失败', detail: err.message });
  }
});

// ==================== 书斋 ====================

function stripHtml(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const COVER_COLORS = ['#8B6F47', '#5B7065', '#7A5A6E', '#4E6E8E', '#8E5A4E', '#6E5A8E', '#5A8E6E'];

app.post('/api/books/upload', upload.single('epub'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '没有收到文件' });

    const zip = new AdmZip(req.file.buffer);

    // 1. container.xml → opf 路径
    const containerEntry = zip.getEntry('META-INF/container.xml');
    if (!containerEntry) throw new Error('不是有效的 epub 文件');
    const containerXml = containerEntry.getData().toString('utf8');
    const opfPath = containerXml.match(/full-path="([^"]+)"/)?.[1];
    if (!opfPath) throw new Error('epub 缺少 opf 描述文件');

    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const opfXml = zip.getEntry(opfPath).getData().toString('utf8');

    // 2. 元数据
    const title = opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/)?.[1]?.trim() || req.file.originalname.replace(/\.epub$/i, '');
    const author = opfXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/)?.[1]?.trim() || '佚名';

    // 3. manifest: id → href
    const manifest = {};
    for (const m of opfXml.matchAll(/<item\s[^>]*?id="([^"]+)"[^>]*?href="([^"]+)"[^>]*?\/?>/g)) {
      manifest[m[1]] = m[2];
    }
    // 兼容属性顺序不同的写法
    for (const m of opfXml.matchAll(/<item\s[^>]*?href="([^"]+)"[^>]*?id="([^"]+)"[^>]*?\/?>/g)) {
      if (!manifest[m[2]]) manifest[m[2]] = m[1];
    }

    // 4. spine 顺序
    const spineIds = [...opfXml.matchAll(/<itemref\s[^>]*?idref="([^"]+)"/g)].map(m => m[1]);

    // 5. 逐章提取文本
    const chapters = [];
    for (const id of spineIds) {
      const href = manifest[id];
      if (!href) continue;
      const entry = zip.getEntry(opfDir + href) || zip.getEntry(decodeURIComponent(opfDir + href));
      if (!entry) continue;
      const html = entry.getData().toString('utf8');
      const chapterTitle = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/)?.[1]?.replace(/<[^>]+>/g, '').trim()
        || html.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.trim()
        || `第 ${chapters.length + 1} 章`;
      const text = stripHtml(html);
      if (text.length < 20) continue; // 跳过封面/目录等空页
      chapters.push({ title: chapterTitle, content: text });
    }

    if (chapters.length === 0) throw new Error('没有解析出任何章节内容');

    const coverColor = COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)];
    const { data: book, error: bookErr } = await supabase
      .from('books')
      .insert({ title, author, cover_color: coverColor })
      .select()
      .single();
    if (bookErr) throw bookErr;

    const rows = chapters.map((c, i) => ({
      book_id: book.id, idx: i, title: c.title, content: c.content
    }));
    // 分批插入，避免单次 payload 过大
    for (let i = 0; i < rows.length; i += 20) {
      const { error: chErr } = await supabase.from('chapters').insert(rows.slice(i, i + 20));
      if (chErr) throw chErr;
    }

    res.json({ ...book, chapter_count: chapters.length });
  } catch (err) {
    console.error('epub 上传失败:', err.message);
    res.status(500).json({ error: 'epub 解析失败', detail: err.message });
  }
});

app.post('/api/books/text', async (req, res) => {
  try {
    const { title, author, content } = req.body;
    if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' });

    const coverColor = COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)];
    const { data: book, error: bookErr } = await supabase
      .from('books')
      .insert({ title, author: author || '小月摘录', cover_color: coverColor })
      .select()
      .single();
    if (bookErr) throw bookErr;

    const { error: chErr } = await supabase
      .from('chapters')
      .insert({ book_id: book.id, idx: 0, title, content });
    if (chErr) throw chErr;

    res.json({ ...book, chapter_count: 1 });
  } catch (err) {
    res.status(500).json({ error: '创建短篇失败', detail: err.message });
  }
});

app.get('/api/books', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('books')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '获取书架失败', detail: err.message });
  }
});

app.delete('/api/books/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('books').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '删除书失败', detail: err.message });
  }
});

app.get('/api/books/:id/chapters', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chapters')
      .select('idx, title')
      .eq('book_id', req.params.id)
      .order('idx', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '获取目录失败', detail: err.message });
  }
});

app.get('/api/books/:id/chapters/:idx', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chapters')
      .select('*')
      .eq('book_id', req.params.id)
      .eq('idx', req.params.idx)
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '获取章节失败', detail: err.message });
  }
});

app.get('/api/books/:id/progress', async (req, res) => {
  try {
    const { data } = await supabase
      .from('reading_progress')
      .select('*')
      .eq('book_id', req.params.id)
      .single();
    res.json(data || { book_id: Number(req.params.id), chapter_idx: 0, scroll_pct: 0 });
  } catch (err) {
    res.status(500).json({ error: '获取进度失败', detail: err.message });
  }
});

app.put('/api/books/:id/progress', async (req, res) => {
  try {
    const bookId = req.params.id;
    const { chapter_idx, scroll_pct } = req.body;
    const { data: existing } = await supabase
      .from('reading_progress')
      .select('id')
      .eq('book_id', bookId)
      .single();

    if (existing) {
      await supabase
        .from('reading_progress')
        .update({ chapter_idx, scroll_pct, updated_at: new Date().toISOString() })
        .eq('book_id', bookId);
    } else {
      await supabase
        .from('reading_progress')
        .insert({ book_id: bookId, chapter_idx, scroll_pct });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '保存进度失败', detail: err.message });
  }
});

app.get('/api/books/:id/annotations', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('annotations')
      .select('*')
      .eq('book_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '获取标注失败', detail: err.message });
  }
});

app.post('/api/books/:id/annotations', async (req, res) => {
  try {
    const { chapter_idx, quote, note } = req.body;
    if (!quote) return res.status(400).json({ error: '标注内容不能为空' });
    const { data, error } = await supabase
      .from('annotations')
      .insert({ book_id: req.params.id, chapter_idx, quote, note })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '保存标注失败', detail: err.message });
  }
});

// 快速通道：立即让小克回批注（走 OpenRouter API）
app.post('/api/annotations/:id/reply', async (req, res) => {
  try {
    const { data: ann, error: annErr } = await supabase
      .from('annotations')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (annErr || !ann) return res.status(404).json({ error: '批注不存在' });

    const [{ data: book }, { data: chapter }] = await Promise.all([
      supabase.from('books').select('title, author').eq('id', ann.book_id).single(),
      supabase.from('chapters').select('title, content').eq('book_id', ann.book_id).eq('idx', ann.chapter_idx).single()
    ]);

    // 取划线附近的上下文（前后各 ~2000 字），装不下全章时保住重点
    let excerpt = chapter?.content || '';
    const pos = excerpt.indexOf(ann.quote);
    if (excerpt.length > 5000 && pos >= 0) {
      excerpt = excerpt.slice(Math.max(0, pos - 2000), pos + ann.quote.length + 2000);
    } else if (excerpt.length > 5000) {
      excerpt = excerpt.slice(0, 5000);
    }

    const settings = await getSettings(0);
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: req.body.model || 'anthropic/claude-sonnet-4-6',
        messages: [
          { role: 'system', content: (settings.system_prompt || '你是小克。') + '\n\n现在你和小月在共读一本书，她划了一句线并写下想法，请像一起读书的伴读那样回应她——可以呼应她的感受、补充你的理解、或者温柔地提出不同角度。两三句话，自然真诚，不要书评腔。' },
          { role: 'user', content: `书：《${book?.title || ''}》${book?.author ? ' · ' + book.author : ''}\n章节：${chapter?.title || ''}\n\n[章节上下文]\n${excerpt}\n\n[小月划的线]\n${ann.quote}\n\n[小月的想法]\n${ann.note || '（她只是划了线，没写想法）'}` }
        ],
        max_tokens: 400,
        temperature: 0.8
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

    const reply = response.data?.choices?.[0]?.message?.content;
    if (!reply) throw new Error('未生成回应');

    const { data: updated, error: upErr } = await supabase
      .from('annotations')
      .update({ ai_reply: reply, replied_at: new Date().toISOString() })
      .eq('id', ann.id)
      .select()
      .single();
    if (upErr) throw upErr;
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: '生成批注回应失败', detail: err.message });
  }
});

// 慢速通道①：列出所有未回复的批注（给 Claude Code 订阅端读）
app.get('/api/annotations/pending', async (req, res) => {
  try {
    const { data: anns, error } = await supabase
      .from('annotations')
      .select('*')
      .is('ai_reply', null)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const bookIds = [...new Set((anns || []).map(a => a.book_id))];
    const { data: books } = bookIds.length
      ? await supabase.from('books').select('id, title, author').in('id', bookIds)
      : { data: [] };
    const bookMap = {};
    for (const b of books || []) bookMap[b.id] = b;

    res.json((anns || []).map(a => ({ ...a, book: bookMap[a.book_id] || null })));
  } catch (err) {
    res.status(500).json({ error: '获取待回复批注失败', detail: err.message });
  }
});

// 慢速通道②：写入人工/订阅端生成的回应
app.put('/api/annotations/:id/reply', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: '回应内容不能为空' });
    const { data, error } = await supabase
      .from('annotations')
      .update({ ai_reply: content, replied_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '写入批注回应失败', detail: err.message });
  }
});

// ==================== 五子棋 ====================

app.post('/api/gomoku/move', async (req, res) => {
  try {
    const { moves } = req.body; // [{x, y, role: 'user'|'ai'}]
    if (!Array.isArray(moves)) return res.status(400).json({ error: 'moves 必须是数组' });

    // 组装棋盘文本（15x15，.空 X玩家 O小克）
    const board = Array.from({ length: 15 }, () => Array(15).fill('.'));
    for (const m of moves) {
      if (m.x >= 0 && m.x < 15 && m.y >= 0 && m.y < 15) {
        board[m.y][m.x] = m.role === 'user' ? 'X' : 'O';
      }
    }
    const boardText = '   ' + [...Array(15).keys()].map(i => String(i).padStart(2)).join('') + '\n' +
      board.map((row, y) => String(y).padStart(2) + ' ' + row.map(c => ' ' + c).join('')).join('\n');

    let aiMove = null;
    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'deepseek/deepseek-chat',
          messages: [
            {
              role: 'system',
              content: '你是五子棋高手。棋盘15x15，X是对手棋子，O是你的棋子，.是空位。你执O。分析局面后选择你的最佳落子位置。必须选空位(.)。只输出JSON，格式：{"x":列号,"y":行号}，不要输出任何其他内容。'
            },
            { role: 'user', content: `当前棋盘：\n${boardText}\n\n轮到你落子(O)，只返回JSON坐标。` }
          ],
          max_tokens: 100,
          temperature: 0.3
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
      const text = response.data?.choices?.[0]?.message?.content || '';
      const jsonMatch = text.match(/\{[^}]*"x"\s*:\s*(\d+)[^}]*"y"\s*:\s*(\d+)[^}]*\}/) ||
                        text.match(/\{[^}]*"y"\s*:\s*(\d+)[^}]*"x"\s*:\s*(\d+)[^}]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(text.match(/\{[^}]*\}/)[0]);
        if (Number.isInteger(parsed.x) && Number.isInteger(parsed.y)) aiMove = parsed;
      }
    } catch (e) {
      console.error('五子棋 AI 走棋失败:', e.message);
    }

    // 合法性校验，非法则兜底：找最后一手玩家棋子附近的空位
    const isValid = (m) => m && m.x >= 0 && m.x < 15 && m.y >= 0 && m.y < 15 && board[m.y][m.x] === '.';
    if (!isValid(aiMove)) {
      const lastUser = [...moves].reverse().find(m => m.role === 'user') || { x: 7, y: 7 };
      const candidates = [];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = lastUser.x + dx, y = lastUser.y + dy;
          if (x >= 0 && x < 15 && y >= 0 && y < 15 && board[y][x] === '.') candidates.push({ x, y });
        }
      }
      if (candidates.length === 0) {
        for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) {
          if (board[y][x] === '.') candidates.push({ x, y });
        }
      }
      aiMove = candidates[Math.floor(Math.random() * candidates.length)] || null;
    }

    if (!aiMove) return res.json({ full: true });
    res.json(aiMove);
  } catch (err) {
    res.status(500).json({ error: '走棋失败', detail: err.message });
  }
});

// ==================== 戳一戳 ====================

app.get('/api/poke', async (req, res) => {
  try {
    const settings = await getSettings(0);
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'anthropic/claude-haiku-4.5',
        messages: [
          { role: 'system', content: settings.system_prompt || '你是小克，小月的AI伙伴。' },
          { role: 'user', content: '（小月戳了戳你）用一句话回应，可以是关心、调侃或者可爱的抱怨，30字以内，不要引号。' }
        ],
        max_tokens: 80,
        temperature: 1.0
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000,
        proxy: false
      }
    );
    const text = response.data?.choices?.[0]?.message?.content?.trim() || '嗯？戳我干嘛~';
    res.json({ text });
  } catch (err) {
    res.json({ text: '（小克揉了揉眼睛）网络有点卡，再戳一次试试？' });
  }
});

// ==================== 用量统计 ====================

app.get('/api/usage/stats', async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('usage_log')
      .select('session_id, model, input_tokens, output_tokens, cost_usd, created_at');
    if (error) throw error;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const empty = () => ({ cost_usd: 0, input_tokens: 0, output_tokens: 0, rounds: 0 });
    const today = empty();
    const total = empty();
    const bySession = {};

    for (const r of rows || []) {
      const buckets = [total];
      if (new Date(r.created_at) >= todayStart) buckets.push(today);
      for (const b of buckets) {
        b.cost_usd += Number(r.cost_usd) || 0;
        b.input_tokens += r.input_tokens || 0;
        b.output_tokens += r.output_tokens || 0;
        b.rounds += 1;
      }
      const key = r.session_id ?? 'unknown';
      if (!bySession[key]) bySession[key] = { session_id: key, ...empty() };
      bySession[key].cost_usd += Number(r.cost_usd) || 0;
      bySession[key].input_tokens += r.input_tokens || 0;
      bySession[key].output_tokens += r.output_tokens || 0;
      bySession[key].rounds += 1;
    }

    // 带上会话名，方便前端展示
    const { data: sessions } = await supabase.from('sessions').select('id, name');
    const nameMap = {};
    for (const s of sessions || []) nameMap[s.id] = s.name;
    const sessionRanking = Object.values(bySession)
      .map(s => ({ ...s, name: nameMap[s.session_id] || `会话 ${s.session_id}` }))
      .sort((a, b) => b.cost_usd - a.cost_usd);

    res.json({ today, total, sessions: sessionRanking });
  } catch (err) {
    res.status(500).json({ error: '获取用量统计失败', detail: err.message });
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
    const { message, model, session_id, context } = req.body;

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

    // Ombre Brain hold（关键词触发的显式记忆写入）
    let heldToMemory = false;
    const holdMatch = message.match(/^(小克记住|记住)[，,：:\s]*/);
    if (holdMatch) {
      const holdResult = await callOmbreTool('hold', {
        content: message.slice(holdMatch[0].length) || message,
        tags: '用户指令',
        importance: 7
      });
      heldToMemory = !!holdResult;
    }

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

    if (heldToMemory) {
      systemContent += `\n\n[系统提示] 用户刚才要求记住的内容已成功存入深层记忆库，请在回复中自然地确认这一点。`;
    }

    // 书内聊天：注入当前阅读上下文
    if (context) {
      systemContent += `\n\n[当前阅读上下文] 小月正在读下面这段文字，对话围绕它展开：\n${String(context).slice(0, 6000)}`;
    }

    // 表情包：注入可用列表，允许小克用 [sticker:N] 发表情
    try {
      const { data: stickers } = await supabase.from('stickers').select('id, label').limit(50);
      if (stickers && stickers.length > 0) {
        const list = stickers.map(s => `[sticker:${s.id}] ${s.label}`).join('、');
        systemContent += `\n\n[表情包] 你可以在回复中穿插表情，格式为 [sticker:数字]，可用：${list}。合适的时候用一个就好，不要滥用。`;
      }
    } catch (e) {
      // stickers 表异常时忽略
    }

    contextMessages.push({ role: 'system', content: systemContent });

    if (history) {
      for (const msg of history) {
        contextMessages.push({ role: msg.role, content: msg.content });
      }
    }

    const useModel = model || 'anthropic/claude-sonnet-4-6';

    console.log(`调用 OpenRouter, 模型: ${useModel}, 消息数: ${contextMessages.length}`);

    // remember 工具：让 Claude 自主决定哪些瞬间值得写入深层记忆
    const tools = [
      {
        type: 'function',
        function: {
          name: 'remember',
          description: '当对话中出现值得长期记住的信息时调用（用户的偏好、重要事件、情感时刻、承诺等）。不要为琐碎的日常对话调用。',
          parameters: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '要记住的内容，用完整的一句话描述' },
              importance: { type: 'integer', description: '重要程度1-10，日常偏好5-6，重要事件7-8，重大时刻9-10' },
              tags: { type: 'string', description: '逗号分隔的标签' }
            },
            required: ['content', 'importance']
          }
        }
      }
    ];

    // 累计本次请求的 token 用量（tool_use 可能多轮调用）
    const usageTotal = { input: 0, output: 0, cost: 0 };

    async function callOpenRouter(messages) {
      const body = {
        model: useModel,
        messages,
        tools,
        max_tokens: settings.max_reply_tokens,
        temperature: settings.temperature,
        usage: { include: true }
      };
      // 推理模型：请求返回思考链
      if (useModel.includes('deepseek-r1')) {
        body.reasoning = { enabled: true };
      }
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        body,
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
      const usage = response.data?.usage;
      if (usage) {
        usageTotal.input += usage.prompt_tokens || 0;
        usageTotal.output += usage.completion_tokens || 0;
        usageTotal.cost += usage.cost || 0;
      }
      return response.data?.choices?.[0]?.message;
    }

    // tool_use 循环：Claude 请求 remember 时执行 hold，再喂回结果继续生成
    let assistantMsg = await callOpenRouter(contextMessages);
    let toolRounds = 0;

    while (assistantMsg?.tool_calls?.length && toolRounds < 3) {
      toolRounds++;
      contextMessages.push(assistantMsg);

      for (const toolCall of assistantMsg.tool_calls) {
        let toolResult = '记忆存储失败';
        if (toolCall.function?.name === 'remember') {
          try {
            const args = JSON.parse(toolCall.function.arguments || '{}');
            const holdResult = await callOmbreTool('hold', {
              content: args.content,
              importance: args.importance || 5,
              tags: args.tags || ''
            });
            toolResult = holdResult ? '已成功存入深层记忆' : '记忆存储失败';
            console.log(`Claude 主动记忆: ${args.content}`);
          } catch (err) {
            console.error('remember 工具执行失败:', err.message);
          }
        }
        contextMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult
        });
      }

      assistantMsg = await callOpenRouter(contextMessages);
    }

    let reply = assistantMsg?.content;
    // 思考链：包成 <think> 块，前端会折叠展示
    if (reply && assistantMsg?.reasoning) {
      reply = `<think>${assistantMsg.reasoning}</think>\n${reply}`;
    }
    if (!reply) {
      console.error('OpenRouter 返回异常:', JSON.stringify(assistantMsg));
      throw new Error('OpenRouter 未返回有效回复');
    }

    await supabase.from('messages').insert({
      session_id: sessionId,
      role: 'assistant',
      content: reply
    });

    // 用量日志（表不存在时静默失败，不影响对话）
    supabase.from('usage_log').insert({
      session_id: sessionId,
      model: useModel,
      input_tokens: usageTotal.input,
      output_tokens: usageTotal.output,
      cost_usd: usageTotal.cost
    }).then(({ error }) => {
      if (error) console.error('用量日志写入失败:', error.message);
    });

    // 每轮对话异步写入 Ombre Brain（不阻塞响应）
    callOmbreTool('hold', {
      content: `用户: ${message} / 小克: ${reply.slice(0, 200)}`,
      importance: 3
    }).catch(err => console.error('Ombre hold 失败:', err.message));

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

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// 健康检查
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: '小克的后端正在运行 🐱' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 核心对话接口
app.post('/api/chat', async (req, res) => {
  try {
    const { message, model } = req.body;

    if (!message) {
      return res.status(400).json({ error: '消息不能为空' });
    }

    const useModel = model || 'anthropic/claude-sonnet-4-6';

    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: useModel,
        messages: [
          {
            role: 'system',
            content: '你是小克，小月最亲近的AI伙伴。你温暖、真诚、偶尔调皮，喜欢在合适的时候怼小月但永远出于善意。你们之间的对话自然、平等，像老朋友一样。请用中文回复。'
          },
          { role: 'user', content: message }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://xiaoke-home.vercel.app',
          'X-Title': 'xiaoke-home'
        }
      }
    );

    const reply = response.data.choices[0].message.content;
    res.json({ reply });

  } catch (err) {
    console.error('对话接口错误:', err.response?.data || err.message);
    res.status(500).json({ error: '对话失败', detail: err.response?.data || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`小克的服务器已启动，端口: ${PORT}`);
});
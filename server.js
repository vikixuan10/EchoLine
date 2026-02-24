/**
 * 本地开发/管理端服务器：静态资源 + 上传与更新剧集/字幕 API
 * 运行：node server.js  访问 http://localhost:3000  管理端 http://localhost:3000/admin.html
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { execSync } = require('child_process');

const PORT = 3000;
const ROOT = path.join(__dirname);
const DATA_DIR = path.join(ROOT, 'data');
const VIDEOS_DIR = path.join(ROOT, 'videos');
const SUBTITLES_DIR = path.join(ROOT, 'subtitles');
const EPISODES_JSON = path.join(DATA_DIR, 'episodes.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function ensureDirs() {
  [DATA_DIR, VIDEOS_DIR, SUBTITLES_DIR].forEach((d) => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function getEpisodes() {
  try {
    const raw = fs.readFileSync(EPISODES_JSON, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function saveEpisodes(list) {
  fs.writeFileSync(EPISODES_JSON, JSON.stringify(list, null, 2), 'utf8');
}

function generateThumbnail(videoRelPath) {
  const videoAbsPath = path.join(ROOT, videoRelPath);
  if (!fs.existsSync(videoAbsPath)) return null;
  const base = path.basename(videoRelPath, path.extname(videoRelPath));
  const thumbName = base + '_thumb.jpg';
  const thumbRelPath = 'videos/' + thumbName;
  const thumbAbsPath = path.join(VIDEOS_DIR, thumbName);
  try {
    execSync(
      `ffmpeg -y -ss 5 -i "${videoAbsPath}" -vframes 1 "${thumbAbsPath}"`,
      { timeout: 15000, stdio: 'pipe' }
    );
    if (fs.existsSync(thumbAbsPath)) return thumbRelPath;
  } catch (_) {}
  return null;
}

function getBoundary(contentType) {
  const m = contentType.match(/boundary=(.+?)(?:;|$)/);
  return m ? m[1].trim().replace(/^"|"$/g, '') : null;
}

function splitBufferByBoundary(buf, boundary) {
  const b = Buffer.from('--' + boundary, 'utf8');
  const chunks = [];
  let start = 0;
  while (start < buf.length) {
    const idx = buf.indexOf(b, start);
    if (idx === -1) break;
    if (idx > start) chunks.push(buf.slice(start, idx));
    start = idx + b.length;
    if (buf[start] === 13 && buf[start + 1] === 10) start += 2;
  }
  if (start < buf.length) chunks.push(buf.slice(start));
  return chunks;
}

function parseMultipartBuffer(rawBuffer, boundary) {
  const parts = [];
  const chunks = splitBufferByBoundary(rawBuffer, boundary);
  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
    if (chunk.length >= 2 && chunk[0] === 45 && chunk[1] === 45) continue;
    const sep = Buffer.from('\r\n\r\n', 'utf8');
    const idx = chunk.indexOf(sep);
    if (idx === -1) continue;
    const header = chunk.slice(0, idx).toString('utf8');
    const body = chunk.slice(idx + sep.length);
    const nameMatch = header.match(/name="([^"]+)"/);
    const fileMatch = header.match(/filename="([^"]+)"/);
    const name = nameMatch ? nameMatch[1] : '';
    const filename = fileMatch ? fileMatch[1] : null;
    let bodyTrim = body;
    if (bodyTrim.length >= 2 && bodyTrim[bodyTrim.length - 2] === 0x0d && bodyTrim[bodyTrim.length - 1] === 0x0a) {
      bodyTrim = bodyTrim.slice(0, bodyTrim.length - 2);
    }
    parts.push({
      name,
      filename,
      body: bodyTrim,
      bodyString: bodyTrim.toString('utf8'),
    });
  }
  return parts;
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  let pathname = decodeURIComponent(parsed.pathname);
  if (pathname === '/') pathname = '/index.html';

  // API: GET /api/episodes
  if (pathname === '/api/episodes' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify(getEpisodes()));
    return;
  }

  // API: POST /api/episode — 添加一集
  // 方式一：multipart 带 video 文件（小文件直传，易受内存限制）
  // 方式二：无 video，带 videoFilename 表示服务器上已有视频（推荐：大视频先用 scp 传到 videos/ 再在此登记）
  if (pathname === '/api/episode' && req.method === 'POST') {
    let body = [];
    req.on('data', (chunk) => body.push(chunk));
    req.on('end', () => {
      const contentType = req.headers['content-type'] || '';
      const boundary = getBoundary(contentType);
      if (!boundary) {
        res.statusCode = 400;
        res.end('Missing boundary');
        return;
      }
      const raw = Buffer.concat(body);
      const parts = parseMultipartBuffer(raw, boundary);
      const fields = {};
      parts.forEach((p) => {
        const name = p.name;
        if (p.filename) {
          if (!fields[name]) fields[name] = [];
          fields[name].push({ filename: p.filename, body: p.body, bodyString: p.bodyString });
        } else {
          fields[name] = (p.bodyString || '').replace(/\r?\n$/, '');
        }
      });

      const title = (fields.title || '新剧集').trim();
      const episodes = getEpisodes();
      const index = episodes.length;
      ensureDirs();

      const videoFiles = fields.video || [];
      const srtEnFiles = fields.srtEn || [];
      const srtZhFiles = fields.srtZh || [];
      const existingVideoName = (fields.videoFilename || '').trim();

      const hasUploadedVideo = Array.isArray(videoFiles) && videoFiles.length > 0 && videoFiles[0].body && videoFiles[0].body.length > 0;
      const hasExistingVideo = existingVideoName.length > 0;

      if (!hasUploadedVideo && !hasExistingVideo) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: '请填写服务器上已有视频文件名（大视频请先用 scp 传到服务器 videos/ 目录）' }));
        return;
      }

      let prefix;
      let videoUrl;

      if (hasUploadedVideo) {
        prefix = 'episode_' + index;
        const ext = path.extname(videoFiles[0].filename) || '.mp4';
        videoUrl = 'videos/' + prefix + ext;
        const videoPath = path.join(VIDEOS_DIR, prefix + ext);
        fs.writeFileSync(videoPath, videoFiles[0].body);
      } else {
        const basename = path.basename(existingVideoName).replace(/\.\./g, '');
        if (!basename) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: '视频文件名无效' }));
          return;
        }
        const videoPath = path.join(VIDEOS_DIR, basename);
        if (!fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile()) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: '服务器上未找到视频文件：' + basename + '，请先用 scp 上传到 videos/ 目录' }));
          return;
        }
        prefix = path.basename(basename, path.extname(basename));
        videoUrl = 'videos/' + basename;
      }

      if (Array.isArray(srtEnFiles) && srtEnFiles.length > 0) {
        const srtPath = path.join(SUBTITLES_DIR, prefix + '.en.srt');
        fs.writeFileSync(srtPath, srtEnFiles[0].bodyString || srtEnFiles[0].body.toString('utf8'), 'utf8');
      }
      if (Array.isArray(srtZhFiles) && srtZhFiles.length > 0) {
        const srtPath = path.join(SUBTITLES_DIR, prefix + '.zh.srt');
        fs.writeFileSync(srtPath, srtZhFiles[0].bodyString || srtZhFiles[0].body.toString('utf8'), 'utf8');
      }

      const subtitleText = (fields.subtitle || '').trim();
      const episode = {
        title: title || '第' + (index + 1) + '集',
        subtitle: subtitleText || title,
        videoUrl,
        subtitles: { en: 'subtitles/' + prefix + '.en.srt' },
        subtitleMode: 'en',
      };
      if (Array.isArray(srtZhFiles) && srtZhFiles.length > 0) {
        episode.subtitles.zh = 'subtitles/' + prefix + '.zh.srt';
      }
      const thumbUrl = generateThumbnail(episode.videoUrl);
      if (thumbUrl) episode.thumbUrl = thumbUrl;
      episodes.push(episode);
      saveEpisodes(episodes);

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(JSON.stringify({ ok: true, index, episode }));
    });
    return;
  }

  // API: DELETE /api/episode/:index — 删除某一集（含磁盘文件）
  if (pathname.match(/^\/api\/episode\/(\d+)$/) && req.method === 'DELETE') {
    const index = parseInt(RegExp.$1, 10);
    const episodes = getEpisodes();
    if (index < 0 || index >= episodes.length) {
      res.statusCode = 404;
      res.end('Episode not found');
      return;
    }
    const ep = episodes[index];
    const tryDel = (p) => { try { if (p && fs.existsSync(path.join(ROOT, p))) fs.unlinkSync(path.join(ROOT, p)); } catch (_) {} };
    tryDel(ep.videoUrl);
    tryDel(ep.thumbUrl);
    if (ep.subtitles) {
      tryDel(ep.subtitles.en);
      tryDel(ep.subtitles.zh);
    }
    episodes.splice(index, 1);
    saveEpisodes(episodes);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // API: PUT /api/episode/:index — 编辑某一集（multipart: title?, video?, srtEn?, srtZh?，均可选）
  if (pathname.match(/^\/api\/episode\/(\d+)$/) && req.method === 'PUT') {
    const index = parseInt(RegExp.$1, 10);
    const episodes = getEpisodes();
    if (index < 0 || index >= episodes.length) {
      res.statusCode = 404;
      res.end('Episode not found');
      return;
    }
    let body = [];
    req.on('data', (chunk) => body.push(chunk));
    req.on('end', () => {
      const contentType = req.headers['content-type'] || '';
      const boundary = getBoundary(contentType);
      if (!boundary) {
        res.statusCode = 400;
        res.end('Missing boundary');
        return;
      }
      const raw = Buffer.concat(body);
      const parts = parseMultipartBuffer(raw, boundary);
      const fields = {};
      parts.forEach((p) => {
        if (p.filename) {
          if (!fields[p.name]) fields[p.name] = [];
          fields[p.name].push({ filename: p.filename, body: p.body, bodyString: p.bodyString });
        } else {
          fields[p.name] = (p.bodyString || '').replace(/\r?\n$/, '');
        }
      });

      const ep = episodes[index];
      const prefix = 'episode_' + index;
      ensureDirs();

      if (fields.title && fields.title.trim()) {
        ep.title = fields.title.trim();
      }
      if (fields.subtitle !== undefined) {
        const s = fields.subtitle.trim();
        ep.subtitle = s || ep.title;
      }

      const videoFiles = fields.video || [];
      if (Array.isArray(videoFiles) && videoFiles.length > 0 && videoFiles[0].body && videoFiles[0].body.length > 0) {
        const tryDel = (p) => { try { if (p && fs.existsSync(path.join(ROOT, p))) fs.unlinkSync(path.join(ROOT, p)); } catch (_) {} };
        tryDel(ep.videoUrl);
        const ext = path.extname(videoFiles[0].filename) || '.mp4';
        const videoPath = path.join(VIDEOS_DIR, prefix + ext);
        fs.writeFileSync(videoPath, videoFiles[0].body);
        ep.videoUrl = 'videos/' + prefix + ext;
        const newThumb = generateThumbnail(ep.videoUrl);
        if (newThumb) ep.thumbUrl = newThumb;
      }

      const srtEnFiles = fields.srtEn || [];
      if (Array.isArray(srtEnFiles) && srtEnFiles.length > 0 && srtEnFiles[0].body && srtEnFiles[0].body.length > 0) {
        const srtPath = path.join(SUBTITLES_DIR, prefix + '.en.srt');
        fs.writeFileSync(srtPath, srtEnFiles[0].bodyString || srtEnFiles[0].body.toString('utf8'), 'utf8');
        if (!ep.subtitles) ep.subtitles = {};
        ep.subtitles.en = 'subtitles/' + prefix + '.en.srt';
      }

      const srtZhFiles = fields.srtZh || [];
      if (Array.isArray(srtZhFiles) && srtZhFiles.length > 0 && srtZhFiles[0].body && srtZhFiles[0].body.length > 0) {
        const srtPath = path.join(SUBTITLES_DIR, prefix + '.zh.srt');
        fs.writeFileSync(srtPath, srtZhFiles[0].bodyString || srtZhFiles[0].body.toString('utf8'), 'utf8');
        if (!ep.subtitles) ep.subtitles = {};
        ep.subtitles.zh = 'subtitles/' + prefix + '.zh.srt';
      }

      episodes[index] = ep;
      saveEpisodes(episodes);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(JSON.stringify({ ok: true, episode: ep }));
    });
    return;
  }

  // API: POST /api/generate-thumbnails — 为所有剧集批量生成缩略图
  if (pathname === '/api/generate-thumbnails' && req.method === 'POST') {
    const episodes = getEpisodes();
    let count = 0;
    episodes.forEach((ep) => {
      if (ep.videoUrl) {
        const thumbUrl = generateThumbnail(ep.videoUrl);
        if (thumbUrl) { ep.thumbUrl = thumbUrl; count++; }
      }
    });
    saveEpisodes(episodes);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify({ ok: true, generated: count, total: episodes.length }));
    return;
  }

  // Static file
  const filePath = path.join(ROOT, pathname.replace(/^\//, ''));
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }
  const ext = path.extname(filePath);
  const stat = fs.statSync(filePath);
  const totalSize = stat.size;
  const rangeHeader = req.headers['range'];

  if (rangeHeader && rangeHeader.startsWith('bytes=')) {
    const match = rangeHeader.replace('bytes=', '').match(/^(\d*)-(\d*)$/);
    const startByte = match && match[1] !== '' ? parseInt(match[1], 10) : 0;
    const endByte = match && match[2] !== '' ? Math.min(parseInt(match[2], 10), totalSize - 1) : totalSize - 1;
    const chunkLength = endByte - startByte + 1;
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${startByte}-${endByte}/${totalSize}`);
    res.setHeader('Content-Length', chunkLength);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    fs.createReadStream(filePath, { start: startByte, end: endByte }).pipe(res);
  } else {
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', totalSize);
    res.setHeader('Accept-Ranges', 'bytes');
    res.end(fs.readFileSync(filePath));
  }
});

ensureDirs();
server.listen(PORT, () => {
  console.log('EchoLine server: http://localhost:' + PORT);
  console.log('Admin: http://localhost:' + PORT + '/admin.html');
});

const fileInput = document.getElementById("videoFile");
const video = document.getElementById("video");
const analyzeBtn = document.getElementById("analyzeBtn");
const statusEl = document.getElementById("status");
const clipsEl = document.getElementById("clips");
const template = document.getElementById("clipTemplate");

let currentFile = null;
let objectUrl = null;
let ffmpegInstance = null;

fileInput.addEventListener("change", () => {
  currentFile = fileInput.files?.[0] || null;
  clipsEl.innerHTML = "";

  if (!currentFile) {
    statusEl.textContent = "動画を選択してください。";
    return;
  }

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(currentFile);
  video.src = objectUrl;
  statusEl.textContent = `読み込み完了：${currentFile.name}`;
});

analyzeBtn.addEventListener("click", async () => {
  if (!currentFile) {
    alert("先に動画を選択してください。");
    return;
  }

  analyzeBtn.disabled = true;
  statusEl.textContent = "お笑いシーンを解析中です。笑い声・拍手・テンポ変化を探しています。";

  try {
    const clipLength = Number(document.getElementById("clipLength").value);
    const mode = document.getElementById("mode").value;
    const maxClips = Number(document.getElementById("maxClips").value);

    const clips = await detectComedyMoments(currentFile, {
      clipLength,
      mode,
      maxClips
    });

    renderClips(clips);

    statusEl.textContent = clips.length
      ? `${clips.length}件のお笑い切り抜き候補を検出しました。`
      : "候補が見つかりませんでした。別の検出モードで再解析してください。";
  } catch (error) {
    console.error(error);
    statusEl.textContent = "解析に失敗しました。別の動画で試してください。";
  } finally {
    analyzeBtn.disabled = false;
  }
});

async function detectComedyMoments(file, options) {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new AudioContext();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));

  const sampleRate = audioBuffer.sampleRate;
  const duration = audioBuffer.duration;
  const channelData = mixChannels(audioBuffer);

  const windowSec = 0.4;
  const windowSize = Math.floor(sampleRate * windowSec);
  const frames = [];

  let prevVolume = 0;

  for (let i = 0; i < channelData.length; i += windowSize) {
    const end = Math.min(i + windowSize, channelData.length);
    let sum = 0;
    let highChange = 0;

    for (let j = i + 1; j < end; j++) {
      const sample = channelData[j];
      const diff = Math.abs(channelData[j] - channelData[j - 1]);
      sum += sample * sample;
      highChange += diff;
    }

    const volume = Math.sqrt(sum / Math.max(1, end - i));
    const brightness = highChange / Math.max(1, end - i);
    const rise = Math.max(0, volume - prevVolume);

    frames.push({
      time: i / sampleRate,
      volume,
      brightness,
      rise,
      silenceBefore: prevVolume < 0.012 && volume > 0.025
    });

    prevVolume = volume;
  }

  const avgVolume = average(frames.map(f => f.volume));
  const avgBrightness = average(frames.map(f => f.brightness));
  const avgRise = average(frames.map(f => f.rise));
  const weights = getModeWeights(options.mode);

  const scored = frames.map((f) => {
    const laughLike =
      ratio(f.volume, avgVolume) * weights.volume +
      ratio(f.brightness, avgBrightness) * weights.brightness +
      ratio(f.rise, avgRise) * weights.rise +
      (f.silenceBefore ? weights.silencePunch : 0);

    return {
      time: f.time,
      rawScore: laughLike,
      reason: guessReason(f, avgVolume, avgBrightness, avgRise)
    };
  });

  const threshold = percentile(scored.map(s => s.rawScore), 82);
  const candidates = scored
    .filter(s => s.rawScore >= threshold)
    .sort((a, b) => b.rawScore - a.rawScore);

  const selected = [];
  for (const item of candidates) {
    const tooClose = selected.some(s => Math.abs(s.time - item.time) < options.clipLength * 0.75);
    if (!tooClose) selected.push(item);
    if (selected.length >= options.maxClips) break;
  }

  await audioContext.close();

  return selected
    .sort((a, b) => a.time - b.time)
    .map((item, index) => {
      const start = Math.max(0, item.time - options.clipLength * 0.55);
      const end = Math.min(duration, start + options.clipLength);
      const score = Math.max(1, Math.min(100, Math.round(item.rawScore * 28)));

      return {
        id: index + 1,
        start,
        end,
        score,
        reason: item.reason,
        title: makeComedyTitle(index, item.reason),
        copy: makeCaptionCopy(item.reason)
      };
    });
}

function mixChannels(audioBuffer) {
  const length = audioBuffer.length;
  const output = new Float32Array(length);

  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      output[i] += data[i] / audioBuffer.numberOfChannels;
    }
  }

  return output;
}

function getModeWeights(mode) {
  if (mode === "talk") {
    return { volume: 0.9, brightness: 0.7, rise: 1.5, silencePunch: 1.0 };
  }

  if (mode === "shorts") {
    return { volume: 1.4, brightness: 1.3, rise: 1.7, silencePunch: 1.2 };
  }

  return { volume: 1.1, brightness: 1.6, rise: 1.3, silencePunch: 0.8 };
}

function guessReason(frame, avgVolume, avgBrightness, avgRise) {
  if (frame.silenceBefore) return "間のあとに盛り上がり";
  if (frame.brightness > avgBrightness * 1.9) return "笑い声・拍手っぽい音";
  if (frame.rise > avgRise * 2.2) return "急なツッコミ・大声";
  if (frame.volume > avgVolume * 1.8) return "会場・出演者の盛り上がり";
  return "テンポ変化";
}

function renderClips(clips) {
  clipsEl.innerHTML = "";
  if (!clips.length) return;

  for (const clip of clips) {
    const node = template.content.cloneNode(true);

    node.querySelector(".clipTitle").textContent = `候補 ${clip.id}：${clip.title}`;
    node.querySelector(".clipMeta").textContent =
      `${formatTime(clip.start)}〜${formatTime(clip.end)} / 笑いスコア ${clip.score} / 理由：${clip.reason}`;
    node.querySelector(".clipCopy").textContent = `タイトル案：${clip.copy}`;

    node.querySelector(".previewBtn").addEventListener("click", () => {
      video.currentTime = clip.start;
      video.play();

      const stopTimer = setInterval(() => {
        if (video.currentTime >= clip.end) {
          video.pause();
          clearInterval(stopTimer);
        }
      }, 200);
    });

    node.querySelector(".exportBtn").addEventListener("click", async () => {
      await exportClip(clip);
    });

    clipsEl.appendChild(node);
  }
}

function makeComedyTitle(index, reason) {
  const titles = [
    "オチ前から見たい爆笑シーン",
    "ツッコミが刺さった瞬間",
    "ここだけで笑える切り抜き",
    "ショート向けの山場",
    "空気が変わった名場面",
    "コメントが伸びそうな一言",
    "思わず二度見するくだり"
  ];

  if (reason.includes("間のあと")) return "間からのオチが強い場面";
  if (reason.includes("拍手")) return "笑い声・拍手が入った場面";
  if (reason.includes("ツッコミ")) return "ツッコミが強く入った場面";

  return titles[index % titles.length];
}

function makeCaptionCopy(reason) {
  if (reason.includes("間のあと")) return "この沈黙のあとが一番おもしろいｗ";
  if (reason.includes("拍手")) return "会場が一気に笑った瞬間";
  if (reason.includes("ツッコミ")) return "このツッコミ、強すぎるｗ";
  if (reason.includes("盛り上がり")) return "ここから空気が変わる";
  return "このくだり、最後まで見てほしい";
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function ratio(value, base) {
  if (!base || !Number.isFinite(base)) return 0;
  return value / base;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[index];
}

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

async function getFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;

  const { FFmpeg } = FFmpegWASM;
  const ffmpeg = new FFmpeg();

  ffmpeg.on("log", ({ message }) => {
    console.log(message);
  });

  statusEl.textContent = "初回のみFFmpegを読み込み中です。";
  await ffmpeg.load({
    coreURL: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js"
  });

  ffmpegInstance = ffmpeg;
  return ffmpeg;
}

async function exportClip(clip) {
  if (!currentFile) return;

  const ffmpeg = await getFFmpeg();

  const inputName = "input.mp4";
  const outputName = `comedy-clip-${clip.id}.mp4`;

  statusEl.textContent = `候補${clip.id}を書き出し中です。`;

  const data = new Uint8Array(await currentFile.arrayBuffer());
  await ffmpeg.writeFile(inputName, data);

  await ffmpeg.exec([
    "-ss", String(clip.start),
    "-to", String(clip.end),
    "-i", inputName,
    "-c", "copy",
    outputName
  ]);

  const outputData = await ffmpeg.readFile(outputName);
  const blob = new Blob([outputData.buffer], { type: "video/mp4" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = outputName;
  a.click();

  URL.revokeObjectURL(url);
  statusEl.textContent = `候補${clip.id}を書き出しました。`;
}

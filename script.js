(function() {
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear().toString();

  const video = document.getElementById('inputVideo');
  const canvas = document.getElementById('outputCanvas');
  const ctx = canvas.getContext('2d');

  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const heightInput = document.getElementById('heightCm');

  const shoulderEl = document.getElementById('shoulderWidth');
  const chestEl = document.getElementById('chestCirc');
  const hipEl = document.getElementById('hipWidth');
  const waistEl = document.getElementById('waistCirc');
  const inseamEl = document.getElementById('inseam');

  let stream = null;
  let running = false;

  const pose = new Pose.Pose({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
  });

  pose.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    enableSegmentation: false,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6
  });

  pose.onResults(onPoseResults);

  function resizeCanvasToVideo() {
    if (!video.videoWidth || !video.videoHeight) return;
    const { videoWidth, videoHeight } = video;
    const dpr = window.devicePixelRatio || 1;
    const displayWidth = video.clientWidth || videoWidth;
    const displayHeight = Math.round(displayWidth * (videoHeight / videoWidth));
    canvas.style.width = displayWidth + 'px';
    canvas.style.height = displayHeight + 'px';
    canvas.width = Math.round(displayWidth * dpr);
    canvas.height = Math.round(displayHeight * dpr);
  }

  async function onPoseResults(results) {
    if (!results || !results.poseLandmarks) {
      drawFrame(null);
      return;
    }
    drawFrame(results);
    estimateMeasurements(results.poseLandmarks);
  }

  function drawFrame(results) {
    resizeCanvasToVideo();
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!results || !results.poseLandmarks) { ctx.restore(); return; }

    const landmarks = results.poseLandmarks.map(lm => ({
      x: lm.x * canvas.width,
      y: lm.y * canvas.height
    }));

    // Draw skeleton
    if (window.drawConnectors && window.drawLandmarks && window.POSE_CONNECTIONS) {
      window.drawConnectors(ctx, landmarks, window.POSE_CONNECTIONS, { color: '#22d3ee', lineWidth: 2 });
      window.drawLandmarks(ctx, landmarks, { color: '#22c55e', radius: 3 });
    } else {
      // Fallback: draw small points
      ctx.fillStyle = '#22c55e';
      landmarks.forEach(pt => { ctx.beginPath(); ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2); ctx.fill(); });
    }
    ctx.restore();
  }

  function getLandmark(lms, idx) {
    if (!lms || lms.length <= idx) return null;
    return lms[idx] || null;
  }

  function distancePx(lms, a, b) {
    const la = getLandmark(lms, a);
    const lb = getLandmark(lms, b);
    if (!la || !lb) return null;
    const dx = (la.x - lb.x) * canvas.width;
    const dy = (la.y - lb.y) * canvas.height;
    return Math.hypot(dx, dy);
  }

  function midpoint(lms, a, b) {
    const la = getLandmark(lms, a);
    const lb = getLandmark(lms, b);
    if (!la || !lb) return null;
    return { x: (la.x + lb.x) / 2, y: (la.y + lb.y) / 2 };
  }

  function estimateMeasurements(lms) {
    const heightCm = parseFloat(heightInput.value);
    if (!heightCm || heightCm < 100 || heightCm > 230) return;

    const VW = canvas.width;
    const VH = canvas.height;

    const headIdx = [0, 7, 8]; // nose, left_ear, right_ear
    const footIdx = [29, 30, 27, 28]; // heels, ankles

    let minY = Infinity;
    let maxY = -Infinity;

    headIdx.forEach(i => { const lm = getLandmark(lms, i); if (lm) minY = Math.min(minY, lm.y * VH); });
    footIdx.forEach(i => { const lm = getLandmark(lms, i); if (lm) maxY = Math.max(maxY, lm.y * VH); });

    if (!isFinite(minY) || !isFinite(maxY) || maxY <= minY) return;

    const pixelHeight = maxY - minY;
    const cmPerPixel = heightCm / pixelHeight;

    const shoulderPx = distancePx(lms, 11, 12); // shoulders
    const hipPx = distancePx(lms, 23, 24); // hips

    let shoulderCm = shoulderPx ? shoulderPx * cmPerPixel : null;
    let hipCm = hipPx ? hipPx * cmPerPixel : null;

    // Approximate circumferences from flat widths (very rough multipliers)
    const chestCircCm = shoulderCm ? shoulderCm * 2.25 : null;
    const waistCircCm = hipCm ? hipCm * 2.0 : null;

    // Inseam: from crotch (mid-hip midpoint) to lowest ankle
    const crotch = midpoint(lms, 23, 24);
    const leftAnkle = getLandmark(lms, 27);
    const rightAnkle = getLandmark(lms, 28);
    let inseamCm = null;
    if (crotch && (leftAnkle || rightAnkle)) {
      const crotchPxY = crotch.y * VH;
      const laY = leftAnkle ? leftAnkle.y * VH : null;
      const raY = rightAnkle ? rightAnkle.y * VH : null;
      const ankleY = Math.max(laY ?? -Infinity, raY ?? -Infinity);
      if (isFinite(ankleY) && ankleY > crotchPxY) {
        inseamCm = (ankleY - crotchPxY) * cmPerPixel;
      }
    }

    setText(shoulderEl, shoulderCm);
    setText(hipEl, hipCm);
    setText(chestEl, chestCircCm);
    setText(waistEl, waistCircCm);
    setText(inseamEl, inseamCm);
  }

  function setText(el, val) {
    if (!el) return;
    if (val == null || !isFinite(val)) { el.textContent = '–'; return; }
    el.textContent = (Math.round(val * 10) / 10).toString();
  }

  async function start() {
    if (running) return;
    const heightCm = parseFloat(heightInput.value);
    if (!heightCm || heightCm < 100 || heightCm > 230) {
      alert('Please enter your height in cm (100–230).');
      heightInput.focus();
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (err) {
      alert('Camera permission denied or not available.');
      console.error(err);
      return;
    }

    video.srcObject = stream;
    await video.play();
    running = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;

    const process = async () => {
      if (!running) return;
      try { await pose.send({ image: video }); } catch (e) { /* ignore frame drops */ }
      requestAnimationFrame(process);
    };
    requestAnimationFrame(process);

    window.addEventListener('resize', resizeCanvasToVideo, { passive: true });
    resizeCanvasToVideo();
  }

  function stop() {
    running = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;

    if (video) {
      try { video.pause(); } catch {}
      if (video.srcObject) {
        const tracks = video.srcObject.getTracks();
        tracks.forEach(t => t.stop());
        video.srcObject = null;
      }
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    window.removeEventListener('resize', resizeCanvasToVideo);
  }

  if (startBtn) startBtn.addEventListener('click', start);
  if (stopBtn) stopBtn.addEventListener('click', stop);
})();

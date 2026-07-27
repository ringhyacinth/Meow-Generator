import * as THREE from 'three';

const CARD_LAYOUT = Object.freeze({
  windowX: 0.08,
  windowY: 0.115,
  windowWidth: 0.84,
  windowHeight: 0.65,
});

export const SHARE_CARD_REPOSITORY = Object.freeze({
  label: 'github.com/ringhyacinth/Meow-Generator',
  url: 'https://github.com/ringhyacinth/Meow-Generator',
});

const CARD_TOTAL = 9999;

const _subjectBounds = new THREE.Box3();
const _subjectCenter = new THREE.Vector3();
const _subjectView = new THREE.Vector3();
const _cameraForward = new THREE.Vector3();
const _cameraRight = new THREE.Vector3();
const _cameraUp = new THREE.Vector3();
const _projectedSubject = new THREE.Vector3();

/**
 * Compute the world-space camera/target translation needed to place the
 * subject at the center of the card window. Translating camera and orbit
 * target by the same vector preserves the user's rotation and zoom.
 */
export function getShareCardSubjectPanOffset({
  camera,
  subject,
  frameRect,
  canvasRect,
}) {
  const offset = new THREE.Vector3();
  if (
    !camera
    || !subject
    || !frameRect
    || !canvasRect
    || canvasRect.width <= 0
    || canvasRect.height <= 0
  ) return offset;

  subject.updateWorldMatrix?.(true, true);
  camera.updateMatrixWorld(true);
  _subjectBounds.setFromObject(subject);
  if (_subjectBounds.isEmpty()) return offset;
  _subjectBounds.getCenter(_subjectCenter);

  const desiredNdcX = (
    ((frameRect.left + frameRect.width * 0.5) - canvasRect.left)
    / canvasRect.width
  ) * 2 - 1;
  const desiredNdcY = -(
    (
      ((frameRect.top + frameRect.height * 0.5) - canvasRect.top)
      / canvasRect.height
    ) * 2 - 1
  );
  _projectedSubject.copy(_subjectCenter).project(camera);

  camera.getWorldDirection(_cameraForward);
  _subjectView.copy(_subjectCenter).sub(camera.position);
  const depth = _subjectView.dot(_cameraForward);
  if (!Number.isFinite(depth) || depth <= camera.near) return offset;

  const worldHeight = 2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  const worldWidth = worldHeight * camera.aspect;
  _cameraRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  _cameraUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

  offset
    .addScaledVector(
      _cameraRight,
      (_projectedSubject.x - desiredNdcX) * worldWidth * 0.5
    )
    .addScaledVector(
      _cameraUp,
      (_projectedSubject.y - desiredNdcY) * worldHeight * 0.5
    );
  return offset;
}

const CARD_THEMES = Object.freeze([
  {
    name: 'peach',
    pattern: 'dots',
    paper: '#fff7dc',
    primary: '#f47f96',
    secondary: '#ffd05b',
    accent: '#45c6c0',
    ink: '#3f302b',
  },
  {
    name: 'sky',
    pattern: 'checker',
    paper: '#f4f5dc',
    primary: '#82add8',
    secondary: '#f08ab0',
    accent: '#ffd358',
    ink: '#303846',
  },
  {
    name: 'lime',
    pattern: 'confetti',
    paper: '#f8f4d9',
    primary: '#a6d84d',
    secondary: '#65c7dc',
    accent: '#ff9d4f',
    ink: '#33412d',
  },
  {
    name: 'orange',
    pattern: 'waves',
    paper: '#fff3d5',
    primary: '#f3a34b',
    secondary: '#ef718e',
    accent: '#70b7c8',
    ink: '#51352b',
  },
]);

const COPY = Object.freeze({
  'zh-CN': {
    camera: '拍照',
    close: '取消',
    saved: '已保存 PNG',
    hint: '拖动画面调整角度',
    title: '猫猫纪念卡',
    skin: '换一个皮肤',
    cardNumber: (serial) => `第 ${serial} 张 / ${CARD_TOTAL}`,
  },
  'ja-JP': {
    camera: '撮影',
    close: '閉じる',
    saved: 'PNG を保存しました',
    hint: 'ドラッグして角度を調整',
    title: 'ねこ記念カード',
    skin: 'スキンを変更',
    cardNumber: (serial) => `${serial} / ${CARD_TOTAL} 枚目`,
  },
  en: {
    camera: 'Capture',
    close: 'Close',
    saved: 'PNG saved',
    hint: 'Drag the scene to adjust the angle',
    title: 'Meow keepsake card',
    skin: 'New skin',
    cardNumber: (serial) => `CARD ${serial} / ${CARD_TOTAL}`,
  },
});

function localeCopy(locale) {
  return COPY[locale] ?? COPY['zh-CN'];
}

function positiveSeed(seed) {
  const numeric = Number(seed);
  return Number.isFinite(numeric) ? Math.abs(Math.trunc(numeric)) : 0;
}

export function getShareCardFilename(seed) {
  return `meow_card_${positiveSeed(seed)}.png`;
}

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function normalizeHex(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(normalized)) return normalized.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(normalized)) {
    return `#${normalized.slice(1).split('').map((digit) => digit.repeat(2)).join('')}`.toLowerCase();
  }
  return fallback;
}

function hexChannels(value) {
  const hex = normalizeHex(value, '#000000').slice(1);
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function channelsHex(channels) {
  return `#${channels
    .map((channel) => clampChannel(channel).toString(16).padStart(2, '0'))
    .join('')}`;
}

function mixHex(a, b, amount) {
  const from = hexChannels(a);
  const to = hexChannels(b);
  const ratio = Math.max(0, Math.min(1, amount));
  return channelsHex(from.map((channel, index) => channel + (to[index] - channel) * ratio));
}

function colorLuma(value) {
  const [r, g, b] = hexChannels(value).map((channel) => channel / 255);
  return r * 0.299 + g * 0.587 + b * 0.114;
}

function normalizeCatPalette(palette = {}) {
  const base = normalizeHex(palette.base, '#f6dfbd');
  const primary = normalizeHex(palette.primary, '#e6913f');
  const secondary = normalizeHex(palette.secondary, '#ad5d22');
  const accent = normalizeHex(palette.accent, '#d99a2b');
  const darkest = [base, primary, secondary, accent]
    .sort((a, b) => colorLuma(a) - colorLuma(b))[0];
  return {
    base,
    primary,
    secondary,
    accent,
    ink: mixHex(darkest, '#2f2927', 0.7),
  };
}

function hashCardValue(seed, variant = 0) {
  let value = (positiveSeed(seed) ^ Math.imul(positiveSeed(variant) + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function rarityFromSeed(seed) {
  const roll = hashCardValue(seed, 17) % 100;
  if (roll < 12) return 'AR';
  if (roll < 38) return 'SR';
  return 'R';
}

function createCatTheme(palette) {
  const cat = normalizeCatPalette(palette);
  return {
    name: 'cat-signature',
    pattern: 'cat-paws',
    paper: mixHex(cat.base, '#fffaf0', 0.78),
    primary: cat.primary,
    secondary: mixHex(cat.base, cat.secondary, 0.36),
    accent: mixHex(cat.accent, '#fff1a8', 0.12),
    ink: cat.ink,
  };
}

function createAlternateTheme(seed, palette, skinVariant) {
  const catTheme = createCatTheme(palette);
  const hash = hashCardValue(seed, skinVariant);
  const rugTheme = CARD_THEMES[hash % CARD_THEMES.length];
  const blend = 0.22 + ((hash >>> 8) % 18) / 100;
  const primaryFirst = ((hash >>> 16) & 1) === 0;
  return {
    name: `cat-remix-${skinVariant}`,
    pattern: rugTheme.pattern,
    paper: mixHex(catTheme.paper, rugTheme.paper, 0.28),
    primary: mixHex(
      primaryFirst ? catTheme.primary : catTheme.secondary,
      rugTheme.primary,
      blend
    ),
    secondary: mixHex(
      primaryFirst ? catTheme.secondary : catTheme.primary,
      rugTheme.secondary,
      blend
    ),
    accent: mixHex(catTheme.accent, rugTheme.accent, 0.32),
    ink: catTheme.ink,
  };
}

export function getShareCardDescriptor(seed, palette, skinVariant = 0) {
  const safeSeed = positiveSeed(seed);
  const safeVariant = positiveSeed(skinVariant);
  const serialNumber = ((safeSeed * 73 + 51) % CARD_TOTAL) + 1;
  const theme = palette
    ? safeVariant === 0
      ? createCatTheme(palette)
      : createAlternateTheme(safeSeed, palette, safeVariant)
    : CARD_THEMES[safeSeed % CARD_THEMES.length];
  return {
    theme,
    serial: String(serialNumber).padStart(4, '0'),
    rarity: rarityFromSeed(safeSeed),
    skinVariant: safeVariant,
    skinSeed: hashCardValue(safeSeed, safeVariant),
  };
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function drawStar(ctx, x, y, radius, color, rotation = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? radius : radius * 0.36;
    const angle = -Math.PI / 2 + i * Math.PI / 4;
    const px = Math.cos(angle) * r;
    const py = Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function drawPaw(ctx, x, y, scale, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(0, 6 * scale, 13 * scale, 11 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  for (const [dx, dy, rx, ry] of [
    [-14, -8, 6, 8],
    [-5, -15, 6, 8],
    [6, -15, 6, 8],
    [15, -7, 6, 8],
  ]) {
    ctx.beginPath();
    ctx.ellipse(dx * scale, dy * scale, rx * scale, ry * scale, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawCardPattern(ctx, {
  cardX,
  cardY,
  cardWidth,
  cardHeight,
  theme,
  skinSeed,
  scale,
}) {
  const topY = cardY;
  const topHeight = cardHeight * 0.12;
  const bottomY = cardY + cardHeight * 0.77;
  const bottomHeight = cardHeight * 0.23;
  const random = (() => {
    let state = skinSeed || 1;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  })();

  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = theme.ink;
  ctx.strokeStyle = theme.ink;

  if (theme.pattern === 'checker') {
    const size = 38 * scale;
    for (const zone of [
      { y: topY, height: topHeight },
      { y: bottomY, height: bottomHeight },
    ]) {
      const columns = Math.ceil(cardWidth / size);
      const rows = Math.ceil(zone.height / size);
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          if ((row + column) % 2 === 0) {
            ctx.fillRect(cardX + column * size, zone.y + row * size, size, size);
          }
        }
      }
    }
  } else if (theme.pattern === 'confetti') {
    ctx.lineWidth = 8 * scale;
    ctx.lineCap = 'round';
    for (let index = 0; index < 48; index++) {
      const bottom = index >= 18;
      const zoneY = bottom ? bottomY : topY;
      const zoneHeight = bottom ? bottomHeight : topHeight;
      const x = cardX + random() * cardWidth;
      const y = zoneY + random() * zoneHeight;
      const length = (12 + random() * 22) * scale;
      const angle = random() * Math.PI;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
      ctx.stroke();
    }
  } else if (theme.pattern === 'waves') {
    ctx.lineWidth = 7 * scale;
    for (const zone of [
      { y: topY, height: topHeight },
      { y: bottomY, height: bottomHeight },
    ]) {
      for (let row = 0; row < 4; row++) {
        const y = zone.y + zone.height * (0.16 + row * 0.25);
        ctx.beginPath();
        for (let x = -40 * scale; x <= cardWidth + 40 * scale; x += 12 * scale) {
          const px = cardX + x;
          const py = y + Math.sin(x / (46 * scale)) * 10 * scale;
          if (x <= -40 * scale) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
  } else if (theme.pattern === 'cat-paws') {
    for (let index = 0; index < 18; index++) {
      const bottom = index >= 7;
      const rowIndex = bottom ? index - 7 : index;
      const count = bottom ? 11 : 7;
      drawPaw(
        ctx,
        cardX + cardWidth * ((rowIndex + 0.55) / count),
        (bottom ? bottomY : topY) + (bottom ? bottomHeight * 0.52 : topHeight * 0.46),
        (bottom ? 0.4 : 0.34) * scale,
        theme.ink
      );
    }
  } else {
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 16; column++) {
        ctx.beginPath();
        ctx.arc(
          cardX + cardWidth * (0.06 + column * 0.059),
          cardY + cardHeight * (0.025 + row * 0.022),
          3.2 * scale,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }
    ctx.lineWidth = 7 * scale;
    for (let i = -3; i < 12; i++) {
      ctx.beginPath();
      ctx.moveTo(cardX + i * 110 * scale, bottomY);
      ctx.lineTo(cardX + (i * 110 + 220) * scale, cardY + cardHeight);
      ctx.stroke();
    }
  }

  ctx.restore();
}

function drawCardDecor(ctx, {
  cardX,
  cardY,
  cardWidth,
  cardHeight,
  windowX,
  windowY,
  windowWidth,
  windowHeight,
  descriptor,
  copy,
}) {
  const { theme, serial, rarity, skinSeed } = descriptor;
  const scale = cardWidth / 1140;
  const outerRadius = 72 * scale;
  const innerRadius = 40 * scale;
  const inkWidth = 12 * scale;

  ctx.save();
  ctx.shadowColor = 'rgba(63, 48, 43, 0.22)';
  ctx.shadowBlur = 30 * scale;
  ctx.shadowOffsetY = 18 * scale;
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardWidth, cardHeight, outerRadius);
  ctx.roundRect(windowX, windowY, windowWidth, windowHeight, innerRadius);
  ctx.fillStyle = theme.paper;
  ctx.fill('evenodd');
  ctx.restore();

  ctx.save();
  roundedRect(ctx, cardX, cardY, cardWidth, cardHeight, outerRadius);
  ctx.clip();
  ctx.fillStyle = theme.primary;
  ctx.fillRect(cardX, cardY, cardWidth, cardHeight * 0.12);
  ctx.fillStyle = theme.secondary;
  ctx.fillRect(cardX, cardY + cardHeight * 0.77, cardWidth, cardHeight * 0.23);
  drawCardPattern(ctx, {
    cardX,
    cardY,
    cardWidth,
    cardHeight,
    theme,
    skinSeed,
    scale,
  });
  ctx.restore();

  roundedRect(ctx, windowX, windowY, windowWidth, windowHeight, innerRadius);
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = inkWidth;
  ctx.stroke();
  roundedRect(
    ctx,
    windowX + inkWidth * 1.1,
    windowY + inkWidth * 1.1,
    windowWidth - inkWidth * 2.2,
    windowHeight - inkWidth * 2.2,
    innerRadius * 0.72
  );
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 5 * scale;
  ctx.stroke();

  roundedRect(ctx, cardX, cardY, cardWidth, cardHeight, outerRadius);
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = inkWidth;
  ctx.stroke();
  roundedRect(
    ctx,
    cardX + inkWidth * 1.35,
    cardY + inkWidth * 1.35,
    cardWidth - inkWidth * 2.7,
    cardHeight - inkWidth * 2.7,
    outerRadius * 0.78
  );
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 5 * scale;
  ctx.stroke();

  ctx.fillStyle = '#fffaf0';
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 8 * scale;
  roundedRect(
    ctx,
    cardX + 46 * scale,
    cardY + 32 * scale,
    310 * scale,
    92 * scale,
    28 * scale
  );
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = theme.ink;
  ctx.font = `900 ${40 * scale}px "Arial Rounded MT Bold", "Microsoft YaHei", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText('MEOW CARD', cardX + 70 * scale, cardY + 80 * scale);

  ctx.beginPath();
  ctx.arc(cardX + cardWidth - 86 * scale, cardY + 78 * scale, 39 * scale, 0, Math.PI * 2);
  ctx.fillStyle = theme.ink;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cardX + cardWidth - 86 * scale, cardY + 78 * scale, 25 * scale, 0, Math.PI * 2);
  ctx.fillStyle = theme.accent;
  ctx.fill();
  drawStar(
    ctx,
    cardX + cardWidth - 86 * scale,
    cardY + 78 * scale,
    15 * scale,
    '#fffaf0',
    Math.PI / 8
  );

  drawStar(ctx, cardX + 52 * scale, cardY + cardHeight * 0.735, 24 * scale, theme.accent, 0.1);
  drawStar(ctx, cardX + cardWidth - 55 * scale, cardY + cardHeight * 0.74, 30 * scale, theme.primary, -0.2);
  drawStar(ctx, cardX + cardWidth - 105 * scale, cardY + cardHeight * 0.19, 19 * scale, theme.secondary, 0.35);

  const captionY = cardY + cardHeight * 0.812;
  ctx.fillStyle = theme.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `900 ${55 * scale}px "Arial Rounded MT Bold", "Microsoft YaHei", sans-serif`;
  ctx.fillText('MEOW GENERATOR', cardX + cardWidth / 2, captionY);
  ctx.font = `800 ${29 * scale}px "Arial Rounded MT Bold", "Microsoft YaHei", sans-serif`;
  ctx.fillText(copy.title, cardX + cardWidth / 2, captionY + 52 * scale);

  const metaY = cardY + cardHeight * 0.894;
  const metaHeight = 66 * scale;
  ctx.fillStyle = 'rgba(255, 250, 240, 0.86)';
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 5 * scale;
  roundedRect(
    ctx,
    cardX + 66 * scale,
    metaY,
    450 * scale,
    metaHeight,
    22 * scale
  );
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = theme.ink;
  ctx.textAlign = 'left';
  ctx.font = `900 ${29 * scale}px "Arial Rounded MT Bold", "Microsoft YaHei", sans-serif`;
  ctx.fillText(copy.cardNumber(serial), cardX + 92 * scale, metaY + metaHeight / 2);

  const rarityX = cardX + cardWidth - 214 * scale;
  const rarityWidth = 148 * scale;
  const rarityGradient = ctx.createLinearGradient(rarityX, metaY, rarityX + rarityWidth, metaY + metaHeight);
  rarityGradient.addColorStop(0, rarity === 'R' ? '#fffaf0' : theme.primary);
  rarityGradient.addColorStop(1, rarity === 'AR' ? theme.accent : rarity === 'SR' ? theme.secondary : theme.paper);
  roundedRect(ctx, rarityX, metaY, rarityWidth, metaHeight, 24 * scale);
  ctx.fillStyle = rarityGradient;
  ctx.fill();
  ctx.strokeStyle = theme.ink;
  ctx.stroke();
  ctx.fillStyle = theme.ink;
  ctx.textAlign = 'center';
  ctx.font = `900 ${36 * scale}px "Arial Rounded MT Bold", "Microsoft YaHei", sans-serif`;
  ctx.fillText(`${rarity} ✦`, rarityX + rarityWidth / 2, metaY + metaHeight / 2);

  const repositoryY = cardY + cardHeight * 0.953;
  roundedRect(
    ctx,
    cardX + 78 * scale,
    repositoryY,
    cardWidth - 156 * scale,
    48 * scale,
    20 * scale
  );
  ctx.fillStyle = 'rgba(255, 250, 240, 0.6)';
  ctx.fill();
  ctx.strokeStyle = mixHex(theme.ink, theme.paper, 0.28);
  ctx.lineWidth = 3 * scale;
  ctx.stroke();
  ctx.fillStyle = theme.ink;
  ctx.textAlign = 'center';
  ctx.font = `800 ${21 * scale}px "Arial Rounded MT Bold", "Microsoft YaHei", sans-serif`;
  ctx.fillText(
    `↗ ${SHARE_CARD_REPOSITORY.label}`,
    cardX + cardWidth / 2,
    repositoryY + 24 * scale
  );

  drawPaw(ctx, cardX + 104 * scale, captionY + 50 * scale, 0.72 * scale, theme.primary);
  drawPaw(ctx, cardX + cardWidth - 104 * scale, captionY + 50 * scale, 0.72 * scale, theme.accent);

  ctx.textAlign = 'left';
}

function captureCanvasRegion(sourceCanvas, sourceRect, targetCanvas, targetRect) {
  const scaleX = sourceCanvas.width / sourceRect.canvasWidth;
  const scaleY = sourceCanvas.height / sourceRect.canvasHeight;
  const sx = Math.max(0, sourceRect.x * scaleX);
  const sy = Math.max(0, sourceRect.y * scaleY);
  const sw = Math.min(sourceCanvas.width - sx, sourceRect.width * scaleX);
  const sh = Math.min(sourceCanvas.height - sy, sourceRect.height * scaleY);
  targetCanvas.drawImage(
    sourceCanvas,
    sx,
    sy,
    sw,
    sh,
    targetRect.x,
    targetRect.y,
    targetRect.width,
    targetRect.height
  );
}

export function createShareCardCapture({
  viewport,
  renderer,
  scene,
  camera,
  controls,
  sceneCanvas,
  getSubject,
  getSeed,
  getPalette,
  getLocale,
  downloadBlob,
}) {
  const overlay = document.createElement('div');
  overlay.className = 'share-card-overlay';
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.setAttribute('data-i18n-ignore', '');
  overlay.innerHTML = `
    <div class="share-card-shell" role="dialog" aria-modal="false">
      <div class="share-card-live-frame">
        <span class="share-card-paper share-card-paper--top"></span>
        <span class="share-card-paper share-card-paper--right"></span>
        <span class="share-card-paper share-card-paper--bottom"></span>
        <span class="share-card-paper share-card-paper--left"></span>
        <span class="share-card-window"></span>
        <span class="share-card-edition">MEOW CARD</span>
        <span class="share-card-gem">✦</span>
        <span class="share-card-star share-card-star--one">✦</span>
        <span class="share-card-star share-card-star--two">★</span>
        <span class="share-card-live-title">MEOW GENERATOR</span>
        <span class="share-card-live-subtitle"></span>
        <span class="share-card-serial"></span>
        <span class="share-card-rarity"></span>
        <a
          class="share-card-repo"
          href="${SHARE_CARD_REPOSITORY.url}"
          target="_blank"
          rel="noreferrer"
        >↗ ${SHARE_CARD_REPOSITORY.label}</a>
      </div>
      <p class="share-card-hint"></p>
      <div class="share-card-actions">
        <button type="button" class="share-card-skin-button"></button>
        <button type="button" class="share-card-capture-button"></button>
        <button type="button" class="share-card-close-button"></button>
      </div>
      <output class="share-card-status" aria-live="polite"></output>
    </div>
  `;
  viewport.appendChild(overlay);

  const shell = overlay.querySelector('.share-card-shell');
  const frame = overlay.querySelector('.share-card-live-frame');
  const windowEl = overlay.querySelector('.share-card-window');
  const serialEl = overlay.querySelector('.share-card-serial');
  const rarityEl = overlay.querySelector('.share-card-rarity');
  const subtitleEl = overlay.querySelector('.share-card-live-subtitle');
  const hintEl = overlay.querySelector('.share-card-hint');
  const skinButton = overlay.querySelector('.share-card-skin-button');
  const captureButton = overlay.querySelector('.share-card-capture-button');
  const closeButton = overlay.querySelector('.share-card-close-button');
  const statusEl = overlay.querySelector('.share-card-status');
  let skinVariant = 0;
  let descriptor = getShareCardDescriptor(getSeed(), getPalette?.(), skinVariant);
  let active = false;
  let cameraPanFrame = 0;

  function alignSubjectToCard() {
    const subject = getSubject?.();
    if (!active || !subject || !controls) return;
    const offset = getShareCardSubjectPanOffset({
      camera,
      subject,
      frameRect: windowEl.getBoundingClientRect(),
      canvasRect: sceneCanvas.getBoundingClientRect(),
    });
    if (offset.lengthSq() < 1e-8) return;

    cancelAnimationFrame(cameraPanFrame);
    const startedAt = performance.now();
    const duration = 280;
    const startCamera = camera.position.clone();
    const startTarget = controls.target.clone();
    const tick = (now) => {
      if (!active) return;
      const linear = THREE.MathUtils.clamp((now - startedAt) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - linear, 3);
      camera.position.copy(startCamera).addScaledVector(offset, eased);
      controls.target.copy(startTarget).addScaledVector(offset, eased);
      controls.update();
      viewport.dataset.shareCardAutoPan = eased.toFixed(3);
      if (linear < 1) cameraPanFrame = requestAnimationFrame(tick);
    };
    cameraPanFrame = requestAnimationFrame(tick);
  }

  function syncCopy() {
    const copy = localeCopy(getLocale());
    hintEl.textContent = copy.hint;
    skinButton.textContent = `🎨 ${copy.skin}`;
    captureButton.textContent = `📸 ${copy.camera}`;
    closeButton.textContent = `× ${copy.close}`;
    subtitleEl.textContent = copy.title;
    serialEl.textContent = copy.cardNumber(descriptor.serial);
    shell.setAttribute('aria-label', copy.title);
  }

  function applyDescriptor() {
    descriptor = getShareCardDescriptor(getSeed(), getPalette?.(), skinVariant);
    const { theme, rarity } = descriptor;
    frame.dataset.theme = theme.name;
    frame.dataset.pattern = theme.pattern;
    frame.dataset.rarity = rarity;
    frame.style.setProperty('--share-paper', theme.paper);
    frame.style.setProperty('--share-primary', theme.primary);
    frame.style.setProperty('--share-secondary', theme.secondary);
    frame.style.setProperty('--share-accent', theme.accent);
    frame.style.setProperty('--share-ink', theme.ink);
    serialEl.textContent = localeCopy(getLocale()).cardNumber(descriptor.serial);
    rarityEl.textContent = `${rarity} ✦`;
    viewport.dataset.shareCardSkin = theme.name;
    viewport.dataset.shareCardRarity = rarity;
  }

  function randomizeSkin() {
    const previousVariant = skinVariant;
    const randomBuffer = new Uint32Array(1);
    globalThis.crypto?.getRandomValues?.(randomBuffer);
    skinVariant = randomBuffer[0] || ((Date.now() ^ positiveSeed(getSeed())) >>> 0);
    if (skinVariant === 0 || skinVariant === previousVariant) skinVariant = previousVariant + 1;
    applyDescriptor();
    statusEl.textContent = '';
  }

  function open() {
    active = true;
    skinVariant = 0;
    applyDescriptor();
    syncCopy();
    statusEl.textContent = '';
    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
    viewport.dataset.shareCardOpen = 'true';
    requestAnimationFrame(() => {
      overlay.classList.add('is-open');
      requestAnimationFrame(alignSubjectToCard);
    });
  }

  function close() {
    if (!active) return;
    active = false;
    cancelAnimationFrame(cameraPanFrame);
    overlay.classList.remove('is-open');
    viewport.dataset.shareCardOpen = 'false';
    window.setTimeout(() => {
      if (!active) {
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
      }
    }, 180);
  }

  async function capture() {
    if (!active) return;
    captureButton.disabled = true;
    statusEl.textContent = '';
    try {
      renderer.render(scene, camera);

      const viewRect = windowEl.getBoundingClientRect();
      const canvasRect = sceneCanvas.getBoundingClientRect();
      const output = document.createElement('canvas');
      output.width = 1200;
      output.height = 1600;
      const ctx = output.getContext('2d');
      const margin = 30;
      const cardX = margin;
      const cardY = margin;
      const cardWidth = output.width - margin * 2;
      const cardHeight = output.height - margin * 2;
      const targetWindow = {
        x: cardX + cardWidth * CARD_LAYOUT.windowX,
        y: cardY + cardHeight * CARD_LAYOUT.windowY,
        width: cardWidth * CARD_LAYOUT.windowWidth,
        height: cardHeight * CARD_LAYOUT.windowHeight,
      };
      const sourceWindow = {
        x: viewRect.left - canvasRect.left,
        y: viewRect.top - canvasRect.top,
        width: viewRect.width,
        height: viewRect.height,
        canvasWidth: canvasRect.width,
        canvasHeight: canvasRect.height,
      };

      ctx.save();
      roundedRect(
        ctx,
        targetWindow.x,
        targetWindow.y,
        targetWindow.width,
        targetWindow.height,
        40
      );
      ctx.clip();
      captureCanvasRegion(sceneCanvas, sourceWindow, ctx, targetWindow);
      ctx.restore();

      drawCardDecor(ctx, {
        cardX,
        cardY,
        cardWidth,
        cardHeight,
        windowX: targetWindow.x,
        windowY: targetWindow.y,
        windowWidth: targetWindow.width,
        windowHeight: targetWindow.height,
        descriptor,
        copy: localeCopy(getLocale()),
      });

      const blob = await new Promise((resolve) => output.toBlob(resolve, 'image/png'));
      if (blob) {
        downloadBlob(blob, getShareCardFilename(getSeed()));
        statusEl.textContent = localeCopy(getLocale()).saved;
        viewport.dataset.shareCardCaptured = 'true';
      }
    } finally {
      captureButton.disabled = false;
    }
  }

  skinButton.addEventListener('pointerdown', (event) => event.stopPropagation());
  captureButton.addEventListener('pointerdown', (event) => event.stopPropagation());
  closeButton.addEventListener('pointerdown', (event) => event.stopPropagation());
  skinButton.addEventListener('click', randomizeSkin);
  captureButton.addEventListener('click', capture);
  closeButton.addEventListener('click', close);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && active) close();
  });
  window.addEventListener('meow:localechange', syncCopy);

  return {
    open,
    close,
    capture,
    get active() { return active; },
  };
}

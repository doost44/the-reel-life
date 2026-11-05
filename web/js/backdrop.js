// The tools' backdrop: the face camera's picture, blurred far out behind the
// glass (ui.css), so the participant is always there behind the controls,
// like the map behind a dashboard. It's blurred here, at a tiny size, where
// it costs almost nothing, and the page only stretches it. Live only:
// nothing is kept.

const EVERY = 150; // ms between redraws: it's a blur, it needn't be smooth

export function startBackdrop(stage, feedName) {
  const canvas = Object.assign(document.createElement('canvas'), { className: 'backdrop', width: 96, height: 54 });
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  ctx.filter = 'blur(3px)';
  let drawn = null;
  setInterval(() => {
    const picture = stage.feeds.get(feedName);
    canvas.classList.toggle('on', Boolean(picture));
    if (!picture || picture === drawn || document.hidden) return;
    drawn = picture;
    try {
      ctx.drawImage(picture, 0, 0, canvas.width, canvas.height);
    } catch {
      // a picture closed as it arrived: the next one will do
    }
  }, EVERY);
}

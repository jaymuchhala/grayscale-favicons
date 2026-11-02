const slider = document.getElementById('slider');
const val = document.getElementById('val');
const lslider = document.getElementById('lslider');
const lval = document.getElementById('lval');
const sw = document.getElementById('sw');
const blk = document.getElementById('blk');

function show(g, l) {
  slider.value = g; val.textContent = g + '%';
  lslider.value = l; lval.textContent = l + '%';
  const t = g / 100;
  const f = Math.round(l * 1.6 * t);
  sw.style.filter = `grayscale(${t})`;
  blk.style.background = `rgb(${f},${f},${f})`; // black swatch shows the lifted grey
}

chrome.storage.local.get({ intensity: 100, lift: 50 }).then(v => show(v.intensity, v.lift));

slider.addEventListener('input', () => {
  show(+slider.value, +lslider.value);
  chrome.storage.local.set({ intensity: +slider.value });
});
lslider.addEventListener('input', () => {
  show(+slider.value, +lslider.value);
  chrome.storage.local.set({ lift: +lslider.value });
});

document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version;

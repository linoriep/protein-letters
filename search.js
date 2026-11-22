'use strict';

// Public static adapter. Saved public library only; files are passed directly
// to the same-browser scan runtime, never to an upload endpoint.
(() => {
const $ = id => document.getElementById(id);
const state = {mode: 'single', busy: false, hasScan: false, best: [], candidates: [], errors: [], page: 0, cached: 0, fresh: 0};
window.ProteinLettersMode = 'single';
const PAGE_SIZE = 24, MIB = 1024 * 1024, MAX_FILE_BYTES = 30 * MIB, MAX_TOTAL_BYTES = 80 * MIB, MAX_INPUTS = 1000;
let indexPromise;
const shardPromises = new Map();

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}
function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !text;
}
function safeURL(value) {
  if (typeof value !== 'string' || !value) return null;
  if (/^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
  try {
    const url = new URL(value, document.baseURI);
    return url.origin === location.origin && ['http:', 'https:', 'blob:'].includes(url.protocol) ? url.href : null;
  } catch (_) { return null; }
}
async function json(path) {
  const response = await fetch(new URL(path, document.baseURI));
  if (!response.ok) throw new Error(`The saved library could not be loaded (${response.status}). Check your connection and retry.`);
  return response.json();
}
function libraryIndex() {
  if (!indexPromise) indexPromise = json('./library/index.json').then(data => {
    if (data.version !== 1 || !data.entries) throw new Error('The saved library index is unreadable.');
    return data;
  }).catch(error => { indexPromise = null; throw error; });
  return indexPromise;
}
async function savedStructure(id) {
  const index = await libraryIndex(), entry = index.entries[id];
  if (!entry) return null;
  if (!/^(?:[0-9]|1[0-5])\.json$/.test(entry.shard)) throw new Error('Invalid saved library shard.');
  if (!shardPromises.has(entry.shard)) shardPromises.set(entry.shard, json('./library/' + entry.shard).catch(error => { shardPromises.delete(entry.shard); throw error; }));
  const shard = await shardPromises.get(entry.shard);
  if (shard.version !== 1 || !shard.entries || !shard.entries[id]) throw new Error(`The saved views for ${id} are unavailable.`);
  return shard.entries[id];
}
function setBusy(busy) {
  state.busy = busy;
  for (const id of ['single-form', 'list-form']) $(id).querySelector('button[type=submit]').disabled = busy;
}
function mode(value) {
  state.mode = value;
  window.ProteinLettersMode = value;
  for (const tab of document.querySelectorAll('.mode-tab')) {
    const active = tab.dataset.mode === value;
    tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    $('panel-' + tab.dataset.mode).hidden = !active;
  }
  $('scan-results').hidden = value === 'word' || !state.hasScan;
  $('job-status').hidden = value === 'word' || !state.hasScan;
  $('word-results').hidden = value !== 'word' || !$('word-board').hasChildNodes();
}
for (const tab of document.querySelectorAll('.mode-tab')) {
  tab.addEventListener('click', () => mode(tab.dataset.mode));
  tab.addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll('.mode-tab')], current = tabs.indexOf(tab);
    let target;
    if (event.key === 'ArrowRight') target = (current + 1) % tabs.length;
    if (event.key === 'ArrowLeft') target = (current + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') target = 0;
    if (event.key === 'End') target = tabs.length - 1;
    if (target !== undefined) { event.preventDefault(); tabs[target].focus(); mode(tabs[target].dataset.mode); }
  });
}
function parseIDs(value) {
  const ids = value.trim() ? value.toUpperCase().trim().split(/[\s,;]+/).filter(Boolean) : [];
  const invalid = ids.filter(id => !/^[0-9][A-Z0-9]{3}$/.test(id));
  if (invalid.length) throw new Error(`Use four-character PDB IDs starting with a digit. Check: ${invalid.slice(0, 5).join(', ')}.`);
  return [...new Set(ids)];
}
function validateFiles(files, count) {
  if (files.length + count > MAX_INPUTS) throw new Error('Use no more than 1,000 PDB IDs and files in a search.');
  let bytes = 0;
  for (const file of files) {
    if (!/\.(pdb|cif|mmcif)$/i.test(file.name)) throw new Error(`Choose a PDB or mmCIF file: ${file.name}.`);
    if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} exceeds the 30 MiB file limit.`);
    bytes += file.size;
    if (bytes > MAX_TOTAL_BYTES) throw new Error('Combined input content exceeds 80 MiB. Split this search into smaller lists.');
  }
}
$('single-file').addEventListener('change', () => {
  const file = $('single-file').files[0];
  $('single-file-note').textContent = file ? `${file.name} · stays in your browser. Clear the PDB ID to use this file.` : 'One ID or file. Files stay in your browser.';
});
$('list-files').addEventListener('change', () => {
  const count = $('list-files').files.length;
  $('list-file-note').textContent = count ? `${count} files selected · up to80 MiB total · files stay in your browser.` : 'Up to 1,000 entries · 80 MiB total.';
});
function validRows(values, inputKey) {
  if (!Array.isArray(values)) throw new Error('The structure scan returned no readable candidate list.');
  const rows = [];
  for (const raw of values) {
    if (!raw || !/^[A-Z]$/.test(raw.letter || '')) continue;
    if (!Array.isArray(raw.rotation) || raw.rotation.length !== 3 || raw.rotation.some(row => !Array.isArray(row) || row.length !== 3 || row.some(value => typeof value !== 'number' || !Number.isFinite(value)))) continue;
    rows.push({pdb_id: String(raw.pdb_id || inputKey), unit: String(raw.unit || 'whole'), letter: raw.letter,
      status: ['candidate', 'uncertain', 'none'].includes(raw.status) ? raw.status : 'none',
      resemblance: Number.isFinite(raw.resemblance) ? raw.resemblance : null,
      ranking_score: Number.isFinite(raw.ranking_score) ? raw.ranking_score : Number.isFinite(raw.resemblance) ? raw.resemblance : 0,
      rotation: raw.rotation, image_url: safeURL(raw.image_url), projection_url: safeURL(raw.projection_url),
      provenance_id: typeof raw.provenance_id === 'string' ? raw.provenance_id : '', input_key: inputKey});
  }
  return rows;
}
function rank(a, b) {
  const order = {candidate: 2, uncertain: 1, none: 0};
  return order[b.status] - order[a.status] || b.ranking_score - a.ranking_score || (b.resemblance || 0) - (a.resemblance || 0);
}
function allRows() {
  const seen = new Set();
  return state.candidates.filter(row => {
    const key = JSON.stringify([row.input_key, row.pdb_id, row.unit, row.letter, row.rotation]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort(rank);
}
function finishRows() {
  const seen = new Set();
  state.best = allRows().filter(row => { if (seen.has(row.input_key)) return false; seen.add(row.input_key); return true; });
}
function updateLetters() {
  const prior = $('letter-filter').value;
  const initial = node('option', 'All letters'); initial.value = '';
  const letters = [...new Set(state.candidates.map(row => row.letter))].sort();
  $('letter-filter').replaceChildren(initial, ...letters.map(letter => { const option = node('option', letter); option.value = letter; return option; }));
  $('letter-filter').value = letters.includes(prior) ? prior : '';
}
function number(value) { return Number.isFinite(value) ? value.toFixed(3) : '—'; }
function resultCard(row) {
  const card = node('article', undefined, 'result-card'), wrap = node('div', undefined, 'card-image');
  if (row.image_url) {
    const a = node('a'); a.href = row.image_url; a.target = '_blank'; a.rel = 'noopener';
    const image = node('img'); image.src = row.image_url; image.loading = 'lazy'; image.alt = `${row.pdb_id} ${row.unit}, proposed letter ${row.letter}`;
    image.addEventListener('error', () => a.replaceWith(node('span', 'Preview unavailable', 'image-missing')), {once: true});
    a.append(image); wrap.append(a);
  } else wrap.append(node('span', 'No preview available', 'image-missing'));
  wrap.append(node('span', row.letter, 'letter-marker')); card.append(wrap);
  const body = node('div', undefined, 'card-content'), heading = node('div', undefined, 'card-heading');
  heading.append(node('h3', row.pdb_id), node('span', {candidate: 'Candidate', uncertain: 'Possible match', none: 'No convincing match'}[row.status], `status-badge status-${row.status}`));
  body.append(heading, node('p', row.unit, 'unit-label'));
  const details = node('details', undefined, 'match-details'), scores = node('div', undefined, 'detail-scores');
  details.append(node('summary', 'Viewing angle & details'));
  scores.append(node('span', 'Visual resemblance'), node('span', number(row.resemblance)));
  const rotation = row.rotation.map(line => line.map(value => value.toFixed(6).padStart(10)).join(' ')).join('\n');
  details.append(scores, node('p', 'Rotation matrix', 'rotation-heading'), node('pre', rotation, 'rotation'), node('p', 'Centered coordinates × rotation transpose; proper rigid rotation. Scores rank shapes and are not probabilities.', 'score-note'));
  if (row.projection_url) { const link = node('a', 'View silhouette ↗', 'projection-link'); link.href = row.projection_url; link.target = '_blank'; link.rel = 'noopener'; details.append(link); }
  if (row.provenance_id) details.append(node('p', 'View ID: ' + row.provenance_id, 'provenance-label'));
  body.append(details); card.append(body); return card;
}
function render() {
  const letter = $('letter-filter').value, all = $('view-filter').value === 'all';
  let rows = (all || letter ? allRows() : state.best).filter(row => !letter || row.letter === letter);
  if (!all && letter) { const seen = new Set(); rows = rows.filter(row => { if (seen.has(row.input_key)) return false; seen.add(row.input_key); return true; }); }
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)); state.page = Math.max(0, Math.min(state.page, pages - 1));
  const start = state.page * PAGE_SIZE;
  $('result-grid').replaceChildren(...rows.slice(start, start + PAGE_SIZE).map(resultCard));
  $('result-total').textContent = rows.length.toLocaleString();
  $('scan-empty').hidden = !!rows.length || state.busy;
  $('result-pager').hidden = rows.length <= PAGE_SIZE;
  $('page-count').textContent = rows.length ? `${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length}` : '0 results';
  $('page-prev').disabled = !state.page; $('page-next').disabled = state.page >= pages - 1;
  $('error-section').hidden = !state.errors.length;
  $('error-heading').textContent = `Structure messages (${state.errors.length})`;
  $('error-list').replaceChildren(...state.errors.map(item => node('li', `${item.name}: ${item.error}`)));
  $('result-meta').textContent = `${state.best.length} structures with saved views · ${state.cached} cached · ${state.fresh} scanned in this browser`;
}
async function startScan(selectedMode) {
  if (state.busy) return;
  notice('');
  let ids, files;
  try {
    ids = parseIDs($(selectedMode === 'single' ? 'single-id' : 'list-ids').value);
    files = [...$(selectedMode === 'single' ? 'single-file' : 'list-files').files];
    if (selectedMode === 'single' && (ids.length > 1 || files.length > 1 || (ids.length && files.length))) throw new Error('Use one PDB ID or one file here. Protein list can combine several.');
    if (!ids.length && !files.length) throw new Error('Enter a PDB ID or choose a structure file.');
    validateFiles(files, ids.length);
  } catch (error) { notice(error.message, true); return; }
  setBusy(true); state.hasScan = true; state.best = []; state.candidates = []; state.errors = []; state.page = 0; state.cached = 0; state.fresh = 0;
  $('view-filter').value = 'best'; $('letter-filter').value = '';
  $('retry-status').hidden = true;
  $('job-status').classList.remove('finished'); $('job-label').textContent = 'Finding letter views';
  mode(state.mode); render();
  const inputs = [...ids.map(id => ({id, name: id})), ...files.map((file, index) => ({file, name: file.name, key: 'file-' + index}))];
  $('job-progress').max = inputs.length; $('job-progress').value = 0;
  try {
    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index];
      $('job-message').textContent = input.name;
      $('job-count').textContent = `${index} of ${inputs.length} structures`;
      try {
        let result = input.id ? await savedStructure(input.id) : null;
        let cached = result && Array.isArray(result.candidates) && result.candidates.length;
        if (!cached) {
          if (!window.ProteinScan || typeof window.ProteinScan.scan !== 'function') throw new Error('Browser scanning is unavailable. Reload the page; saved public IDs can still be searched.');
          const content = input.file ? await input.file.text() : undefined;
          result = await window.ProteinScan.scan({pdbId: input.id, filename: input.file?.name, content,
            onProgress: progress => {
              const text = typeof progress === 'string' ? progress : progress?.message || progress?.stage;
              if (text) $('job-message').textContent = `${input.name} · ${text}`;
            }});
          state.fresh++;
        } else state.cached++;
        if (!result || typeof result !== 'object') throw new Error('The browser scan returned an unreadable result.');
        const rows = validRows(result.candidates || [], input.id || input.key);
        state.candidates.push(...rows);
        if (result.error) state.errors.push({name: input.name, error: String(result.error)});
        else if (!rows.length) state.errors.push({name: input.name, error: 'No usable A–Z protein view was found in the supplied first model.'});
      } catch (error) { state.errors.push({name: input.name, error: error.message || String(error)}); }
      $('job-progress').value = index + 1; $('job-count').textContent = `${index + 1} of ${inputs.length} structures`;
      if (index % 10 === 0 || index === inputs.length - 1) { finishRows(); updateLetters(); render(); }
    }
  } finally {
    setBusy(false); finishRows(); updateLetters(); render();
    $('job-label').textContent = state.errors.length === inputs.length && !state.candidates.length ? 'No protein views found' : 'Search complete';
    $('job-message').textContent = state.errors.length ? `${state.errors.length} structures have a message below.` : '';
    $('job-status').classList.add('finished');
  }
}
$('single-form').addEventListener('submit', event => { event.preventDefault(); startScan('single'); });
$('list-form').addEventListener('submit', event => { event.preventDefault(); startScan('list'); });
for (const id of ['view-filter', 'letter-filter']) $(id).addEventListener('change', () => { state.page = 0; render(); });
$('page-prev').addEventListener('click', () => { state.page--; render(); });
$('page-next').addEventListener('click', () => { state.page++; render(); });
mode('single');
})();

// R032 word builder follows in its own scope, retaining per-position choices.

(() => {
'use strict';

const $ = id => document.getElementById(id);
const state = {wordBusy: false, lastWord: null, artWord: null,
  wordChoices: Object.create(null), pickerPosition: null, pickerOpener: null};

function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined && text !== null) result.textContent = String(text);
  if (className) result.className = className;
  return result;
}
function showNotice(text, error = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !text;
}
function safeLocalURL(value) {
  if (typeof value !== 'string' || !/^assets\/[a-f0-9]{64}\.png$/.test(value)) return null;
  return new URL(value, document.baseURI).href;
}

let cataloguePromise;
function letterCatalogue() {
  if (!cataloguePromise) {
    cataloguePromise = fetch(new URL('letters.json', document.baseURI)).then(async response => {
      if (!response.ok) throw new Error('The letter shapes could not be loaded. Try again.');
      const data = await response.json();
      if (data.version !== 1 || !data.letters) throw new Error('Letter shapes are unavailable.');
      return data.letters;
    }).catch(error => {
      cataloguePromise = null;
      throw error;
    });
  }
  return cataloguePromise;
}
async function staticWord(word) {
  const catalogue = await letterCatalogue();
  const letters = [];
  for (let position = 0; position < word.length; position++) {
    const letter = word[position];
    if (letter === ' ') continue;
    const options = Array.isArray(catalogue[letter]) ? catalogue[letter] : [];
    letters.push({position, letter, match: options[0], options});
  }
  return {word, letters};
}

const WORD_STORAGE_KEY = 'protein-letters-art-word-v1';

// Validate the artwork catalogue separately from search scores or review grades.
function wordOption(value, letter) {
  if (!value || value.letter !== letter || typeof value.id !== 'string' || !value.id || value.id.length > 512 || !['protein', 'assembled'].includes(value.kind)) return null;
  const image = safeLocalURL(value.image_url);
  if (!image) return null;
  return {id: value.id, letter, kind: value.kind, image_url: image, is_default: value.is_default === true,
    label: typeof value.label === 'string' ? value.label.slice(0, 160) : letter,
    pdb_id: typeof value.pdb_id === 'string' ? value.pdb_id.slice(0, 20) : null,
    unit: typeof value.unit === 'string' ? value.unit.slice(0, 50) : null};
}
function normalizeWordResult(result, word, previous = {}) {
  if (!result || result.word !== word || !Array.isArray(result.letters)) throw new Error('The word response could not be read. Try again.');
  const positions = new Map();
  for (const entry of result.letters) {
    if (entry && Number.isInteger(entry.position) && entry.position >= 0 && entry.position < word.length && entry.letter === word[entry.position]) positions.set(entry.position, entry);
  }
  const letters = [], choices = Object.create(null);
  for (let position = 0; position < word.length; position++) {
    const letter = word[position];
    if (letter === ' ') continue;
    const entry = positions.get(position), options = [], seen = new Set();
    for (const value of Array.isArray(entry?.options) ? entry.options.slice(0, 100) : []) {
      const option = wordOption(value, letter);
      if (option && !seen.has(option.id)) { seen.add(option.id); options.push(option); }
    }
    const offeredMatch = wordOption(entry?.match, letter);
    const fallback = options.find(option => option.is_default) || options.find(option => option.id === offeredMatch?.id) || options[0] || null;
    const match = options.find(option => option.id === previous[position]) || fallback;
    if (match) choices[position] = match.id;
    letters.push({position, letter, match, options});
  }
  return {word, letters, choices};
}
function saveWordChoices() {
  try { localStorage.setItem(WORD_STORAGE_KEY, JSON.stringify({version: 1, word: state.lastWord, choices: state.wordChoices})); } catch (_) { /* Storage is optional. */ }
}
function restoreWordChoices() {
  try {
    const saved = JSON.parse(localStorage.getItem(WORD_STORAGE_KEY));
    if (saved?.version !== 1 || typeof saved.word !== 'string' || saved.word.length > 60 || !/^[A-Z ]+$/.test(saved.word) || !saved.word.trim()) return;
    state.lastWord = saved.word; $('word-input').value = saved.word;
    if (saved.choices && typeof saved.choices === 'object' && !Array.isArray(saved.choices)) {
      for (let position = 0; position < saved.word.length; position++) {
        const id = saved.choices[position];
        if (typeof id === 'string' && id.length <= 512) state.wordChoices[position] = id;
      }
    }
  } catch (_) { /* Ignore malformed browser-local settings. */ }
}
function optionCaption(option) {
  return option.kind === 'assembled' ? 'Assembled · protein pieces' : [option.pdb_id || 'Protein', option.unit || 'whole'].join(' · ');
}
function setWordColor(color) {
  $('original-letter-color').hidden = !color;
  if (color) {
    const channels = color.slice(1).match(/../g).map(hex => parseInt(hex, 16) / 255);
    const matrix = channels.flatMap(channel => [0.299, 0.587, 0.114]
      .map(weight => weight * (1 - channel)).concat(0, channel));
    $('word-color-matrix').setAttribute('values', [...matrix, 0, 0, 0, 1, 0].join(' '));
  } else $('letter-color').value = '#244d44';
  for (const img of document.querySelectorAll('#word-board img, #letter-picker-options img')) {
    img.style.filter = color ? 'url(#word-color-filter)' : '';
  }
}
$('letter-color').addEventListener('input', event => setWordColor(event.target.value));
$('original-letter-color').addEventListener('click', () => setWordColor(null));
function optionImage(option, letter) {
  const img = node('img'); img.src = option.image_url; img.alt = `${letter} · ${optionCaption(option)}`; img.loading = 'lazy';
  if (!$('original-letter-color').hidden) img.style.filter = 'url(#word-color-filter)';
  img.addEventListener('error', () => img.replaceWith(node('span', 'Preview unavailable', 'word-image-error')), {once: true});
  return img;
}
function wordTile(entry) {
  const tile = node('article', undefined, 'word-tile' + (entry.match ? '' : ' missing'));
  const button = node('button', undefined, 'word-choice-button'); button.type = 'button'; button.dataset.position = String(entry.position);
  button.setAttribute('aria-label', `Change ${entry.letter} at position ${entry.position + 1}`); button.setAttribute('aria-haspopup', 'dialog');
  button.append(node('span', entry.letter, 'word-char'));
  if (entry.match) {
    button.append(optionImage(entry.match, entry.letter), node('span', optionCaption(entry.match), 'word-protein'));
  } else button.append(node('span', 'No shape available', 'word-protein'));
  button.append(node('span', 'Change', 'word-change'));
  button.disabled = !entry.options.length;
  button.addEventListener('click', () => openLetterPicker(entry.position, button));
  tile.append(button); return tile;
}
function drawArtWord() {
  const current = state.artWord;
  if (!current) return;
  const positions = new Map(current.letters.map(entry => [entry.position, entry])), tiles = [], missing = new Set();
  for (let position = 0; position < current.word.length; position++) {
    if (current.word[position] === ' ') { const space = node('span', undefined, 'word-space'); space.setAttribute('aria-label', 'Space'); tiles.push(space); continue; }
    const entry = positions.get(position); if (!entry.match) missing.add(entry.letter); tiles.push(wordTile(entry));
  }
  $('word-board').replaceChildren(...tiles); $('word-heading').textContent = current.word;
  $('word-message').textContent = 'Default letters · click to replace';
  $('word-missing').hidden = !missing.size;
  $('word-missing').textContent = missing.size ? `Shapes unavailable: ${[...missing].join(', ')}.` : '';
  $('word-results').hidden = window.ProteinLettersMode !== 'word';
}
function applyWordResult(result, word) {
  const previous = state.lastWord === word ? state.wordChoices : {};
  const current = normalizeWordResult(result, word, previous);
  state.artWord = current; state.lastWord = word; state.wordChoices = current.choices;
  drawArtWord(); saveWordChoices();
}
function closeLetterPicker() {
  if ($('letter-picker').open) $('letter-picker').close();
}
function openLetterPicker(position, opener) {
  const entry = state.artWord?.letters.find(item => item.position === position);
  if (!entry || !entry.options.length) return;
  state.pickerPosition = position; state.pickerOpener = opener;
  $('letter-picker-title').textContent = `Choose ${entry.letter}`;
  $('letter-picker-hint').textContent = `Position ${position + 1} · only this letter changes`;
  const buttons = entry.options.map(option => {
    const button = node('button', undefined, 'letter-option'); button.type = 'button';
    button.setAttribute('aria-pressed', String(option.id === entry.match?.id));
    button.append(optionImage(option, entry.letter));
    const caption = optionCaption(option), title = option.label || caption;
    button.append(node('span', title, 'option-name'));
    if (title !== caption) button.append(node('small', caption, 'option-kind'));
    if (option.is_default && option.label !== 'Default') button.append(node('span', 'Default', 'option-default'));
    button.addEventListener('click', () => {
      // Bind to the current position and catalogue; repeated letters stay independent.
      const active = state.artWord?.letters.find(item => item.position === position);
      const choice = active?.options.find(item => item.id === option.id);
      if (!choice) return;
      active.match = choice; state.wordChoices[position] = choice.id;
      drawArtWord(); saveWordChoices(); closeLetterPicker();
    });
    return button;
  });
  $('letter-picker-options').replaceChildren(...buttons);
  $('letter-picker').showModal();
  (buttons.find(button => button.getAttribute('aria-pressed') === 'true') || buttons[0]).focus();
}
$('close-letter-picker').addEventListener('click', closeLetterPicker);
$('letter-picker').addEventListener('click', event => { if (event.target === $('letter-picker')) closeLetterPicker(); });
$('letter-picker').addEventListener('close', () => {
  const position = state.pickerPosition;
  const replacement = [...$('word-board').querySelectorAll('.word-choice-button')].find(button => button.dataset.position === String(position));
  const target = replacement || state.pickerOpener;
  state.pickerPosition = null; state.pickerOpener = null;
  if (target?.isConnected) target.focus();
});
$('word-form').addEventListener('submit', async event => {
  event.preventDefault(); await buildArtWord($('word-input').value);
});
async function buildArtWord(input, quiet = false) {
  if (state.wordBusy || $('letter-picker').open) return;
  const word = input.toUpperCase().trim();
  if (!word || word.length > 60 || !/^[A-Z ]+$/.test(word)) { if (!quiet) showNotice('Use letters A–Z and spaces, up to 60 characters.', true); return; }
  state.wordBusy = true; const button = $('word-form').querySelector('button'); button.disabled = true;
  if (!quiet) showNotice('');
  try { applyWordResult(await staticWord(word), word); }
  catch (error) { showNotice(error.message, true); }
  finally { state.wordBusy = false; button.disabled = false; }
}
restoreWordChoices();
buildArtWord($('word-input').value);

})();

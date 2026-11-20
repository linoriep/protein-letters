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
function optionImage(option, letter) {
  const img = node('img'); img.src = option.image_url; img.alt = `${letter} · ${optionCaption(option)}`; img.loading = 'lazy';
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
  $('word-results').hidden = false;
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

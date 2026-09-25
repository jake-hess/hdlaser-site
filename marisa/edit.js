/* Section editor for /marisa/. Loads only when the page URL ends in ?edit.
   Click Edit on a section, change the text in place, click Save. Save commits
   the page to GitHub (jake-hess/hdlaser-site, main) and Pages republishes it
   within about a minute. A GitHub fine-grained token with Contents: read/write
   on this repo is asked for once and kept in this browser's localStorage. */
(function () {
  var OWNER = 'jake-hess', REPO = 'hdlaser-site', PATH = 'marisa/index.html', BRANCH = 'main';
  var TOKEN_KEY = 'hdlaser.marisa.ghtoken';
  var API = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + PATH;

  var css = [
    'body{padding-top:54px}',
    '#edbar{position:fixed;top:0;left:0;right:0;z-index:1000;background:#22201D;color:#F5F0E9;font:14px/1.3 Figtree,system-ui,sans-serif;display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:10px 16px;box-shadow:0 2px 10px rgba(0,0,0,.25)}',
    '#edbar b{font-family:Fraunces,Georgia,serif;font-size:16px}',
    '#edbar .st{flex:1;min-width:160px;color:#D8D0C5}',
    '#edbar button{background:#F5F0E9;color:#22201D;border:0;border-radius:999px;padding:7px 14px;font:inherit;font-weight:700;cursor:pointer}',
    '#edbar button.ghost{background:transparent;color:#F5F0E9;border:1.5px solid #8A8178}',
    '.edit-host{position:relative;scroll-margin-top:72px}',
    '.edit-ui{position:absolute;top:8px;right:8px;z-index:20;display:flex;gap:6px}',
    '.edit-ui button{background:#B8766B;color:#fff;border:0;border-radius:999px;padding:7px 14px;font:700 13px/1 Figtree,system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2)}',
    '.edit-ui button.cancel{background:#6B635B}',
    '.edit-ui button.save{background:#2F6B4F}',
    '.edit-ui button:disabled{opacity:.6;cursor:default}',
    '.edit-host.editing{outline:3px dashed #B8766B;outline-offset:8px;border-radius:12px}',
    '.edit-host.editing .bee-drift{animation:none}',
    '[contenteditable="true"] a{pointer-events:none}',
    '#parade{display:none!important}'
  ].join('\n');
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var bar = document.createElement('div'); bar.id = 'edbar';
  bar.innerHTML = '<b>Editing Marisa’s page</b><span class="st" id="edstatus">Click Edit on any section. Save commits it and the live page updates in about a minute.</span>' +
    '<button class="ghost" id="edtoken"></button><button id="eddone">Done editing</button>';
  document.body.appendChild(bar);
  var status = document.getElementById('edstatus');
  function say(msg, isErr) { status.textContent = msg; status.style.color = isErr ? '#F2B0A5' : '#D8D0C5'; }

  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) {} refreshTokenBtn(); }
  function refreshTokenBtn() { document.getElementById('edtoken').textContent = getToken() ? 'Forget GitHub token' : 'Set GitHub token'; }
  function askToken() {
    var t = window.prompt('Paste a GitHub fine-grained token for jake-hess/hdlaser-site with Contents: Read and write.\n\nGitHub → Settings → Developer settings → Personal access tokens → Fine-grained → Generate. Repository access: only hdlaser-site. Permissions: Contents → Read and write.\n\nIt stays in this browser only.');
    if (t) { setToken(t.trim()); say('Token saved in this browser.'); }
    return getToken();
  }
  document.getElementById('edtoken').addEventListener('click', function () {
    if (getToken()) { if (confirm('Forget the GitHub token stored in this browser?')) { setToken(''); say('Token removed from this browser.'); } }
    else askToken();
  });
  document.getElementById('eddone').addEventListener('click', function () {
    if (current && !confirm('You are still editing a section. Leave without saving it?')) return;
    location.href = location.pathname;
  });
  refreshTokenBtn();
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) {}

  var current = null, snapshot = '';
  var blocks = document.querySelectorAll('[data-edit]');
  Array.prototype.forEach.call(blocks, function (block) {
    block.classList.add('edit-host');
    var ui = document.createElement('div'); ui.className = 'edit-ui';
    ui.innerHTML = '<button type="button" class="edit">Edit “' + (block.getAttribute('data-edit-title') || block.getAttribute('data-edit')) + '”</button>';
    block.insertBefore(ui, block.firstChild);
    ui.querySelector('.edit').addEventListener('click', function () { start(block); });
  });

  function uiFor(block) { return block.querySelector(':scope > .edit-ui'); }

  function start(block) {
    if (current) { say('Finish the section you are editing first (Save or Cancel).', true); return; }
    current = block;
    snapshot = serialize(block);
    block.setAttribute('contenteditable', 'true');
    block.setAttribute('spellcheck', 'true');
    block.classList.add('editing');
    var ui = uiFor(block);
    ui.innerHTML = '<button type="button" class="cancel">Cancel</button><button type="button" class="save">Save</button>';
    ui.querySelector('.cancel').addEventListener('click', function () { cancel(block); });
    ui.querySelector('.save').addEventListener('click', function () { save(block); });
    ui.setAttribute('contenteditable', 'false');
    say('Editing “' + title(block) + '”. Click into the text and type. Save when you are happy with it.');
    block.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function title(block) { return block.getAttribute('data-edit-title') || block.getAttribute('data-edit'); }

  function finish(block) {
    block.removeAttribute('contenteditable');
    block.removeAttribute('spellcheck');
    block.classList.remove('editing');
    var ui = uiFor(block);
    ui.innerHTML = '<button type="button" class="edit">Edit “' + title(block) + '”</button>';
    ui.querySelector('.edit').addEventListener('click', function () { start(block); });
    current = null;
  }

  function cancel(block) {
    // Put the block back exactly as it was when Edit was clicked.
    var tmp = document.createElement('div'); tmp.innerHTML = snapshot;
    var fresh = tmp.firstElementChild;
    block.innerHTML = fresh.innerHTML;
    var ui = document.createElement('div'); ui.className = 'edit-ui'; block.insertBefore(ui, block.firstChild);
    finish(block);
    say('Changes to “' + title(block) + '” discarded.');
  }

  // The block as it should appear in the file: no editor chrome, no live state.
  function serialize(block) {
    var c = block.cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll('.edit-ui'), function (n) { n.parentNode.removeChild(n); });
    c.removeAttribute('contenteditable'); c.removeAttribute('spellcheck');
    c.classList.remove('edit-host', 'editing');
    if (!c.getAttribute('class')) c.removeAttribute('class');
    var owl = c.querySelector('#owlsay'); if (owl) owl.textContent = '';
    return c.outerHTML;
  }

  function utf8ToB64(str) { return btoa(unescape(encodeURIComponent(str))); }
  function b64ToUtf8(b64) { return decodeURIComponent(escape(atob(b64.replace(/\n/g, '')))); }

  function gh(method, url, token, body) {
    return fetch(url, {
      method: method,
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) { var e = new Error(j.message || ('HTTP ' + r.status)); e.status = r.status; throw e; } return j; });
    });
  }

  function save(block) {
    var token = getToken() || askToken();
    if (!token) { say('No token, nothing saved. Your edits are still on screen.', true); return; }
    var key = block.getAttribute('data-edit');
    var html = serialize(block);
    var btns = uiFor(block).querySelectorAll('button');
    Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
    say('Saving “' + title(block) + '”…');
    gh('GET', API + '?ref=' + BRANCH + '&t=' + Date.now(), token).then(function (file) {
      var text = b64ToUtf8(file.content);
      var open = '<!-- edit:' + key + ' -->', close = '<!-- /edit:' + key + ' -->';
      var a = text.indexOf(open), b = text.indexOf(close);
      if (a < 0 || b < 0 || b < a) throw new Error('Could not find the “' + key + '” section markers in the file.');
      var updated = text.slice(0, a + open.length) + '\n' + html + '\n' + text.slice(b);
      if (updated === text) { say('Nothing changed in “' + title(block) + '”.'); finish(block); return null; }
      return gh('PUT', API, token, { message: 'Marisa page: edit “' + title(block) + '”', content: utf8ToB64(updated), sha: file.sha, branch: BRANCH });
    }).then(function (res) {
      if (res === null) return;
      finish(block);
      say('Saved “' + title(block) + '”. The live page updates in about a minute.');
    }).catch(function (err) {
      Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
      var msg = err && err.message ? err.message : String(err);
      if (err && (err.status === 401 || err.status === 403)) msg += ' — the token was refused. Use “Forget GitHub token” and set a new one.';
      if (err && err.status === 409) msg += ' — the file changed on GitHub while you were editing. Click Save again.';
      say('Not saved: ' + msg, true);
    });
  }

  window.addEventListener('beforeunload', function (e) { if (current) { e.preventDefault(); e.returnValue = ''; } });
})();

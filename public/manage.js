// Dashboard tabs that manage Paddle data through the app's /api/manage endpoints:
// transactions, subscriptions, customers, discounts and webhook deliveries.
// Relies on globals from settings.html: $, esc, money, token, status, STATUS.
(() => {
  let mode = null;
  const lists = {};        // tab -> { after }
  const loaded = new Set();

  function call(method, path, body) {
    const sep = path.includes('?') ? '&' : '?';
    return fetch(`${path}${sep}mode=${mode}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body ? JSON.stringify({ ...body, mode }) : undefined,
    }).then(async (r) => {
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || 'Request failed');
      return json;
    });
  }

  const date = (s) => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
  const dateTime = (s) => (s ? new Date(s).toLocaleString() : '—');
  const who = (c) => (c ? esc(c.name || c.email || c.id) + (c.name && c.email ? `<br><small style="color:var(--muted)">${esc(c.email)}</small>` : '') : '—');
  const cycleText = (c) => (c ? (Number(c.frequency) === 1 ? `/ ${c.interval}` : `/ ${c.frequency} ${c.interval}s`) : '');
  const SUB = { active: ['Active', 'ok'], trialing: ['Trialing', 'ok'], past_due: ['Past due', 'err'], paused: ['Paused', 'warn'], canceled: ['Canceled', ''] };
  const badge = (map, s) => { const [l, c] = map[s] || [s, '']; return `<span class="badge ${c}">${esc(l)}</span>`; };
  const errorRow = (cols, msg) => `<tr><td colspan="${cols}" class="empty" style="color:var(--err)">${esc(msg)}</td></tr>`;
  const emptyRow = (cols, msg) => `<tr><td colspan="${cols}" class="empty">${esc(msg)}</td></tr>`;

  // ---- mode switch (live / sandbox), shared by every tab ----
  function renderModes() {
    if (!mode) mode = status && status.live.connected ? 'live' : 'test';
    document.querySelectorAll('[data-modes]').forEach((el) => {
      el.innerHTML = ['live', 'test'].map((m) =>
        `<button data-mode="${m}" class="${m === mode ? 'on' : ''}" ${status && status[m].connected ? '' : 'disabled title="Not connected"'}>${m === 'live' ? 'Live' : 'Sandbox'}</button>`).join('');
      el.querySelectorAll('button').forEach((b) => b.onclick = () => {
        mode = b.dataset.mode;
        loaded.clear();
        renderModes();
        const tab = document.querySelector('nav button.active').dataset.tab;
        window.onTabShown(tab);
      });
    });
  }

  // ---- drawer ----
  function openDrawer(html) {
    $('drawerBody').innerHTML = html;
    $('drawer').hidden = false;
  }
  function closeDrawer() { $('drawer').hidden = true; }
  $('drawerClose').onclick = closeDrawer;
  $('drawer').onclick = (e) => { if (e.target.id === 'drawer') closeDrawer(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  function drawerMsg(text, ok) {
    const m = $('drawerMsg');
    if (m) { m.textContent = text; m.className = 'msg ' + (ok ? 'ok' : 'err'); }
  }

  // ---- generic paged list ----
  async function loadList(key, url, rowsEl, moreEl, cols, render, append) {
    const state = lists[key] || (lists[key] = {});
    if (!append) { state.after = null; $(rowsEl).innerHTML = emptyRow(cols, 'Loading…'); }
    try {
      const data = await call('GET', url + (append && state.after ? `&after=${encodeURIComponent(state.after)}` : ''));
      const html = data.items.map(render).join('');
      if (append) $(rowsEl).insertAdjacentHTML('beforeend', html);
      else $(rowsEl).innerHTML = html || emptyRow(cols, 'Nothing here yet.');
      state.after = data.next;
      $(moreEl).hidden = !data.next;
    } catch (err) {
      $(rowsEl).innerHTML = errorRow(cols, err.message);
      $(moreEl).hidden = true;
    }
  }

  // ---- transactions ----
  const txUrl = () => `/api/manage/transactions?q=${encodeURIComponent($('txQ').value.trim())}&status=${encodeURIComponent($('txStatus').value)}`;
  const txRow = (t) => `<tr class="click" data-tx="${esc(t.id)}"><td>${esc(date(t.createdAt))}</td><td>${who(t.customer)}</td>
    <td>${esc(t.items.join(', ') || '—')}${t.subscriptionId ? ' <span class="badge test">Subscription</span>' : ''}</td>
    <td>${badge(STATUS, t.status)}</td><td class="num">${esc(money(t.total, t.currency))}</td></tr>`;
  function loadTx(append) { return loadList('tx', txUrl(), 'txRows', 'txMore', 5, txRow, append); }
  let txTimer;
  $('txQ').oninput = () => { clearTimeout(txTimer); txTimer = setTimeout(() => loadTx(false), 400); };
  $('txStatus').onchange = () => loadTx(false);
  $('txMore').onclick = () => loadTx(true);
  $('txRows').onclick = (e) => { const r = e.target.closest('[data-tx]'); if (r) showTransaction(r.dataset.tx); };

  async function showTransaction(id) {
    openDrawer('<p class="empty">Loading…</p>');
    try {
      const t = await call('GET', `/api/manage/transactions/${encodeURIComponent(id)}`);
      const m = (v) => esc(money(v, t.currency));
      openDrawer(`<h2>${m(t.total)} · ${badge(STATUS, t.status)}</h2>
        <div style="color:var(--muted);font-size:13px">${esc(t.id)}</div>
        <dl class="kv">
          <dt>Customer</dt><dd>${who(t.customer)}</dd>
          <dt>Date</dt><dd>${esc(dateTime(t.createdAt))}</dd>
          ${t.invoiceNumber ? `<dt>Invoice</dt><dd>${esc(t.invoiceNumber)}</dd>` : ''}
          ${t.subscriptionId ? `<dt>Subscription</dt><dd>${esc(t.subscriptionId)}</dd>` : ''}
        </dl>
        <table><tbody>
          ${t.lines.map((l) => `<tr><td>${esc(l.name)}${l.quantity > 1 ? ` × ${l.quantity}` : ''}</td><td class="num">${m(l.total)}</td></tr>`).join('')}
          <tr><td style="color:var(--muted)">Subtotal</td><td class="num">${m(t.subtotal)}</td></tr>
          ${t.discount ? `<tr><td style="color:var(--muted)">Discount</td><td class="num">−${m(t.discount)}</td></tr>` : ''}
          <tr><td style="color:var(--muted)">Tax</td><td class="num">${m(t.tax)}</td></tr>
          <tr><td><b>Total</b></td><td class="num"><b>${m(t.total)}</b></td></tr>
          ${t.fee != null ? `<tr><td style="color:var(--muted)">Paddle fee</td><td class="num">−${m(t.fee)}</td></tr>` : ''}
          ${t.earnings != null ? `<tr><td style="color:var(--muted)">Your earnings</td><td class="num">${m(t.earnings)}</td></tr>` : ''}
        </tbody></table>
        <div class="actions-row">
          ${t.refundable ? '<button class="btn secondary" id="dInvoice">Download invoice (PDF)</button>' : ''}
          ${t.customer ? '<button class="btn secondary" id="dCustomer">View customer</button>' : ''}
        </div>
        ${t.adjustments.length ? `<h3>Refunds and adjustments</h3><table><tbody>${t.adjustments.map((a) =>
          `<tr><td>${esc(date(a.createdAt))} · ${esc(a.action)}<br><small style="color:var(--muted)">${esc(a.reason || '')}</small></td><td>${esc(a.status.replace('_', ' '))}</td><td class="num">${m(a.total)}</td></tr>`).join('')}</tbody></table>` : ''}
        ${t.refundable ? `<h3>Refund</h3>
          <div class="form-grid"><label>Amount (${esc(t.currency)})<input id="rfAmount" type="number" min="0" step="0.01" placeholder="Full refund"></label>
          <label>Reason<input id="rfReason" placeholder="Requested by customer"></label></div>
          <div class="actions-row"><button class="btn" id="rfGo">Refund</button></div>
          <p class="sub-muted">Leave the amount empty for a full refund. Paddle may hold a refund for review before approving it.</p>` : ''}
        <div class="msg" id="drawerMsg"></div>`);
      if ($('dInvoice')) $('dInvoice').onclick = async (e) => {
        e.target.disabled = true;
        try { window.open((await call('GET', `/api/manage/transactions/${encodeURIComponent(t.id)}/invoice`)).url, '_blank', 'noopener'); }
        catch (err) { drawerMsg(err.message); }
        e.target.disabled = false;
      };
      if ($('dCustomer')) $('dCustomer').onclick = () => showCustomer(t.customer.id);
      if ($('rfGo')) $('rfGo').onclick = async (e) => {
        const amount = $('rfAmount').value;
        if (!confirm(amount ? `Refund ${money(Number(amount), t.currency)}?` : `Refund the full ${money(t.total, t.currency)}?`)) return;
        e.target.disabled = true;
        try {
          const r = await call('POST', `/api/manage/transactions/${encodeURIComponent(t.id)}/refund`, { amount, reason: $('rfReason').value });
          drawerMsg(r.status === 'pending_approval' ? 'Refund submitted. Paddle is reviewing it.' : `Refund ${r.status.replace('_', ' ')}.`, true);
          setTimeout(() => showTransaction(t.id), 1200);
        } catch (err) { drawerMsg(err.message); e.target.disabled = false; }
      };
    } catch (err) {
      openDrawer(`<p class="msg err">${esc(err.message)}</p>`);
    }
  }

  // ---- CSV export ----
  $('txExportBtn').onclick = () => {
    $('txExport').hidden = !$('txExport').hidden;
    if (!$('exFrom').value) {
      const d = new Date(); $('exTo').value = d.toISOString().slice(0, 10);
      d.setDate(1); $('exFrom').value = d.toISOString().slice(0, 10);
    }
  };
  $('exGo').onclick = async (e) => {
    e.target.disabled = true;
    const msg = $('exMsg'); msg.className = 'msg ok'; msg.textContent = 'Preparing export…';
    try {
      const { id } = await call('POST', '/api/manage/export', { from: $('exFrom').value, to: $('exTo').value });
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const r = await call('GET', `/api/manage/export/${encodeURIComponent(id)}`);
        if (r.url) { msg.innerHTML = `Ready: <a href="${esc(r.url)}" target="_blank" rel="noopener">download CSV</a>`; e.target.disabled = false; return; }
        if (r.status === 'error' || r.status === 'expired') throw new Error('Paddle could not create the export. Try a shorter date range.');
      }
      throw new Error('The export is taking a while. Try again in a few minutes.');
    } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
    e.target.disabled = false;
  };

  // ---- subscriptions ----
  const subRow = (s) => `<tr class="click" data-sub="${esc(s.id)}"><td>${who(s.customer)}</td><td>${esc(s.items.join(', '))}</td>
    <td>${badge(SUB, s.status)}${s.scheduledChange ? `<br><small style="color:var(--muted)">${esc(s.scheduledChange.action)}s ${esc(date(s.scheduledChange.effectiveAt))}</small>` : ''}</td>
    <td>${esc(date(s.nextBilledAt))}</td><td class="num">${esc(money(s.amount, s.currency))} ${esc(cycleText(s.cycle))}</td></tr>`;
  const subCache = new Map();
  function loadSubs(append) {
    return loadList('sub', `/api/manage/subscriptions?status=${encodeURIComponent($('subStatus').value)}`, 'subRows', 'subMore', 5,
      (s) => { subCache.set(s.id, s); return subRow(s); }, append);
  }
  $('subStatus').onchange = () => loadSubs(false);
  $('subMore').onclick = () => loadSubs(true);
  $('subRows').onclick = (e) => { const r = e.target.closest('[data-sub]'); if (r) showSubscription(subCache.get(r.dataset.sub)); };

  function showSubscription(s) {
    const live = ['active', 'trialing', 'past_due'].includes(s.status);
    const pendingCancel = s.scheduledChange && s.scheduledChange.action === 'cancel';
    openDrawer(`<h2>${esc(money(s.amount, s.currency))} ${esc(cycleText(s.cycle))} · ${badge(SUB, s.status)}</h2>
      <div style="color:var(--muted);font-size:13px">${esc(s.id)}</div>
      <dl class="kv">
        <dt>Customer</dt><dd>${who(s.customer)}</dd>
        <dt>Plan</dt><dd>${esc(s.items.join(', '))}</dd>
        <dt>Started</dt><dd>${esc(date(s.startedAt))}</dd>
        <dt>Next payment</dt><dd>${esc(date(s.nextBilledAt))}</dd>
        ${s.scheduledChange ? `<dt>Scheduled</dt><dd>${esc(s.scheduledChange.action)} on ${esc(date(s.scheduledChange.effectiveAt))}</dd>` : ''}
      </dl>
      <div class="actions-row">
        ${live && !pendingCancel ? '<button class="btn secondary" data-act="cancel" data-when="next_billing_period">Cancel at period end</button><button class="btn secondary" data-act="cancel" data-when="immediately">Cancel now</button>' : ''}
        ${pendingCancel ? '<button class="btn secondary" data-act="cancel" data-undo="1">Keep subscription</button>' : ''}
        ${live && !s.scheduledChange ? '<button class="btn secondary" data-act="pause" data-when="next_billing_period">Pause</button>' : ''}
        ${s.status === 'paused' ? '<button class="btn secondary" data-act="resume">Resume</button>' : ''}
        <button class="btn secondary" id="dPortal">Customer portal link</button>
        <button class="btn secondary" id="dTx">Payments</button>
      </div>
      <div class="msg" id="drawerMsg"></div>`);
    $('drawerBody').querySelectorAll('[data-act]').forEach((b) => b.onclick = async () => {
      const label = b.textContent;
      if (!confirm(`${label}?`)) return;
      b.disabled = true;
      try {
        await call('POST', `/api/manage/subscriptions/${encodeURIComponent(s.id)}/${b.dataset.act}`, { when: b.dataset.when, undo: !!b.dataset.undo });
        drawerMsg('Done.', true);
        loaded.delete('subscriptions'); loadSubs(false);
        setTimeout(closeDrawer, 900);
      } catch (err) { drawerMsg(err.message); b.disabled = false; }
    });
    $('dPortal').onclick = () => portalLink(s.customer.id);
    $('dTx').onclick = () => { closeDrawer(); $('txQ').value = s.id; showTab('transactions'); loadTx(false); };
  }

  async function portalLink(customerId) {
    try {
      const { url } = await call('POST', `/api/manage/customers/${encodeURIComponent(customerId)}/portal`, {});
      if (!url) throw new Error('Paddle did not return a portal link.');
      try { await navigator.clipboard.writeText(url); drawerMsg('Portal link copied. Send it to the customer to update their card or cancel. It expires after a while.', true); }
      catch { drawerMsg(url, true); }
    } catch (err) { drawerMsg(err.message); }
  }

  // ---- customers ----
  const cuRow = (c) => `<tr class="click" data-cu="${esc(c.id)}"><td>${esc(c.name || '—')}</td><td>${esc(c.email)}</td><td>${esc(date(c.createdAt))}</td><td>${esc(c.status)}</td></tr>`;
  function loadCustomers(append) {
    return loadList('cu', `/api/manage/customers?q=${encodeURIComponent($('cuQ').value.trim())}`, 'cuRows', 'cuMore', 4, cuRow, append);
  }
  let cuTimer;
  $('cuQ').oninput = () => { clearTimeout(cuTimer); cuTimer = setTimeout(() => loadCustomers(false), 400); };
  $('cuMore').onclick = () => loadCustomers(true);
  $('cuRows').onclick = (e) => { const r = e.target.closest('[data-cu]'); if (r) showCustomer(r.dataset.cu); };

  async function showCustomer(id) {
    openDrawer('<p class="empty">Loading…</p>');
    try {
      const c = await call('GET', `/api/manage/customers/${encodeURIComponent(id)}`);
      const paid = c.transactions.filter((t) => t.status === 'completed' || t.status === 'billed');
      const byCur = {};
      paid.forEach((t) => { byCur[t.currency] = (byCur[t.currency] || 0) + t.total; });
      openDrawer(`<h2>${esc(c.name || c.email)}</h2><div style="color:var(--muted);font-size:13px">${esc(c.email)} · ${esc(c.id)}</div>
        <dl class="kv"><dt>Customer since</dt><dd>${esc(date(c.createdAt))}</dd>
          <dt>Total paid</dt><dd>${Object.entries(byCur).map(([cur, v]) => esc(money(v, cur))).join(' · ') || '—'}</dd></dl>
        <div class="actions-row"><button class="btn secondary" id="dPortal">Customer portal link</button></div>
        <div class="msg" id="drawerMsg"></div>
        <h3>Subscriptions</h3>
        ${c.subscriptions.length ? `<table><tbody>${c.subscriptions.map((s) => { subCache.set(s.id, s); return `<tr class="click" data-sub="${esc(s.id)}"><td>${esc(s.items.join(', '))}</td><td>${badge(SUB, s.status)}</td><td class="num">${esc(money(s.amount, s.currency))} ${esc(cycleText(s.cycle))}</td></tr>`; }).join('')}</tbody></table>` : '<p class="sub-muted">None.</p>'}
        <h3>Payments</h3>
        ${c.transactions.length ? `<table><tbody>${c.transactions.map((t) => `<tr class="click" data-tx="${esc(t.id)}"><td>${esc(date(t.createdAt))}</td><td>${badge(STATUS, t.status)}</td><td class="num">${esc(money(t.total, t.currency))}</td></tr>`).join('')}</tbody></table>` : '<p class="sub-muted">None.</p>'}`);
      $('dPortal').onclick = () => portalLink(c.id);
      $('drawerBody').querySelectorAll('[data-tx]').forEach((r) => r.onclick = () => showTransaction(r.dataset.tx));
      $('drawerBody').querySelectorAll('[data-sub]').forEach((r) => r.onclick = () => showSubscription(subCache.get(r.dataset.sub)));
    } catch (err) {
      openDrawer(`<p class="msg err">${esc(err.message)}</p>`);
    }
  }

  // ---- discounts ----
  const dcRow = (d) => `<tr><td><code>${esc(d.code || '—')}</code><br><small style="color:var(--muted)">${esc(d.description || '')}</small></td>
    <td>${d.type === 'percentage' ? `${esc(d.amount)}% off` : `${esc(money(d.amount, d.currency))} off`}${d.recur ? '<br><small style="color:var(--muted)">incl. renewals</small>' : ''}</td>
    <td>${esc(d.timesUsed)}${d.usageLimit ? ` / ${esc(d.usageLimit)}` : ''}</td><td>${esc(date(d.expiresAt))}</td>
    <td><button class="btn secondary" data-dc="${esc(d.id)}" data-to="${d.status === 'active' ? 'archived' : 'active'}">${d.status === 'active' ? 'Archive' : 'Restore'}</button></td></tr>`;
  async function loadDiscounts() {
    $('dcRows').innerHTML = emptyRow(5, 'Loading…');
    try {
      const { items } = await call('GET', `/api/manage/discounts?status=${$('dcStatus').value}`);
      $('dcRows').innerHTML = items.map(dcRow).join('') || emptyRow(5, 'No discount codes yet.');
    } catch (err) { $('dcRows').innerHTML = errorRow(5, err.message); }
  }
  $('dcStatus').onchange = loadDiscounts;
  $('dcRows').onclick = async (e) => {
    const b = e.target.closest('[data-dc]'); if (!b) return;
    b.disabled = true;
    try { await call('PATCH', `/api/manage/discounts/${encodeURIComponent(b.dataset.dc)}`, { status: b.dataset.to }); loadDiscounts(); }
    catch (err) { alertRow(err.message); b.disabled = false; }
  };
  function alertRow(text) { $('dcMsg').className = 'msg err'; $('dcMsg').textContent = text; }
  $('dcCreate').onclick = async (e) => {
    e.target.disabled = true; $('dcMsg').textContent = '';
    try {
      await call('POST', '/api/manage/discounts', {
        code: $('dcCode').value, type: $('dcType').value, amount: $('dcAmount').value, currency: $('dcCurrency').value,
        usageLimit: $('dcLimit').value, expiresAt: $('dcExpires').value, recur: $('dcRecur').checked,
      });
      $('dcMsg').className = 'msg ok'; $('dcMsg').textContent = 'Code created.';
      ['dcCode', 'dcAmount', 'dcLimit', 'dcExpires'].forEach((i) => $(i).value = '');
      $('dcStatus').value = 'active'; loadDiscounts();
    } catch (err) { alertRow(err.message); }
    e.target.disabled = false;
  };
  $('allowCodes').onchange = async (e) => {
    try { await call('POST', '/api/manage/preferences', { allowDiscountCodes: e.target.checked }); }
    catch (err) { e.target.checked = !e.target.checked; alertRow(err.message); }
  };

  // ---- webhook deliveries ----
  const WH = { delivered: ['Delivered', 'ok'], failed: ['Failed', 'err'], needs_retry: ['Retrying', 'warn'], not_attempted: ['Queued', ''] };
  async function loadWebhooks() {
    $('whRows').innerHTML = emptyRow(4, 'Loading…');
    try {
      const { items } = await call('GET', '/api/manage/webhooks');
      $('whRows').innerHTML = items.map((n) => `<tr><td>${esc(n.type)}</td><td>${esc(dateTime(n.occurredAt))}</td><td>${badge(WH, n.status)}</td>
        <td>${n.status === 'failed' || n.status === 'needs_retry' ? `<button class="btn secondary" data-replay="${esc(n.id)}">Send again</button>` : ''}</td></tr>`).join('')
        || emptyRow(4, 'No deliveries yet. They appear after the first payment.');
    } catch (err) { $('whRows').innerHTML = errorRow(4, err.message); }
  }
  $('whRows').onclick = async (e) => {
    const b = e.target.closest('[data-replay]'); if (!b) return;
    b.disabled = true;
    try { await call('POST', `/api/manage/webhooks/${encodeURIComponent(b.dataset.replay)}/replay`, {}); b.textContent = 'Sent'; setTimeout(loadWebhooks, 3000); }
    catch (err) { b.textContent = 'Failed'; b.title = err.message; }
  };

  // ---- tab hook ----
  const LOADERS = {
    transactions: () => loadTx(false),
    subscriptions: () => loadSubs(false),
    customers: () => loadCustomers(false),
    discounts: async () => {
      loadDiscounts();
      try { $('allowCodes').checked = (await call('GET', '/api/manage/preferences')).allowDiscountCodes; } catch {}
    },
    connections: () => { if (status && (status.live.connected || status.test.connected)) loadWebhooks(); },
  };
  window.onTabShown = (name) => {
    if (!LOADERS[name]) return;
    renderModes();
    if (!status || (!status.live.connected && !status.test.connected)) {
      if (name !== 'connections') document.querySelectorAll(`#tab-${name} tbody`).forEach((b) => b.innerHTML = emptyRow(5, 'Connect a Paddle key first (Connections tab).'));
      return;
    }
    if (loaded.has(name)) return;
    loaded.add(name);
    LOADERS[name]();
  };
})();

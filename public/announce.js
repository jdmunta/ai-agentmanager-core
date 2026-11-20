// Update: what to tell the people who asked, in the document dialog. A Slack message and an email,
// both short and yours to change, and the details they point to (src/announce.js writes them).
// Nothing is sent from here until you press the button that sends it.

const withLink = (text, link) => (link ? `${text.trim()}\n\nDetails: ${link}` : text.trim());
/** A link that opens the device's mail program with the message filled in: addresses split on commas, spaces or semicolons. */
export function mailtoFor(to, subject, body) {
  const list = String(to ?? '').split(/[,;\s]+/).filter(Boolean).map((addr) => encodeURIComponent(addr).replace(/%40/g, '@'));
  return `mailto:${list.join(',')}?subject=${encodeURIComponent(subject ?? '')}&body=${encodeURIComponent(body ?? '')}`;
}
const sentSome = (u) => Boolean(u?.sent?.slack || u?.sent?.email);

/** Whether an update written by itself still waits to be sent (the inbox card). */
export const updateWaits = (a) => Boolean(a.announce?.auto && a.docs?.update?.markdown && !a.docs.update.pending && !a.announce.dismissedAt && !sentSome(a.announce));

export function updateHtml(a, d, { esc, docHtml }) {
  const p = d.parts ?? {};
  const to = a.announce?.to ?? (/@/.test(p.to ?? '') ? p.to : '');
  return `<div class="upd" data-upd="${esc(a.id)}">
    <p class="hint">Drafts, written from the work as it stands (${esc(d.stage ?? 'in progress')}). Change them as you like: nothing goes to anyone until you send it.</p>
    <div data-upd-claims></div>
    <section class="ha-card upd-card">
      <h3>Slack</h3>
      <textarea data-upd-text="slack" rows="6" aria-label="The Slack message">${esc(p.slack ?? '')}</textarea>
      <p class="hint" data-upd-note="slack"></p>
      <div class="need-actions"><button type="button" class="small primary" data-upd-act="copy-slack">Copy</button><button type="button" class="small" data-upd-act="post-slack">Post to Slack</button></div>
    </section>
    <section class="ha-card upd-card">
      <h3>Email</h3>
      <label>To <input data-upd-text="to" type="text" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="${esc(p.to && !to ? `${p.to}'s address` : 'name@example.com, another@example.com')}" value="${esc(to)}" /></label>
      <label>Subject <input data-upd-text="subject" type="text" value="${esc(p.subject ?? '')}" /></label>
      <textarea data-upd-text="email" rows="9" aria-label="The email">${esc(p.email ?? '')}</textarea>
      <p class="hint" data-upd-note="email"></p>
      <div class="need-actions"><button type="button" class="small primary" data-upd-act="mail" title="Open it in this device's mail program, ready to send">Open in mail</button><button type="button" class="small" data-upd-act="copy-email">Copy</button></div>
    </section>
    <section class="ha-card upd-card">
      <h3>Details</h3>
      <label>Link to the details <input data-upd-text="link" type="url" placeholder="https://… where they can read what is below" value="${esc(a.announce?.link ?? '')}" /></label>
      <p class="hint" data-upd-note="link"></p>
      <div class="need-actions"><button type="button" class="small" data-upd-act="publish" title="Put the details below in a Google Doc, through the Google Drive connector of your Claude account; its link then goes under both messages">Publish to Google Drive</button><button type="button" class="small ghost" data-upd-act="dismiss" title="This update is not needed: take it out of the inbox">Not needed</button></div>
      <div class="md upd-details">${docHtml(d.markdown)}</div>
    </section>
  </div>`;
}

export function initUpdateView({ body, api, toast, ago, agentOf, upsert, claimsNote = null }) {
  let slack; // where Post to Slack goes: undefined until asked, null when nowhere
  const root = () => body.querySelector('[data-upd]');
  const field = (k) => root()?.querySelector(`[data-upd-text="${k}"]`);
  const note = (k, text) => {
    const el = root()?.querySelector(`[data-upd-note="${k}"]`);
    if (el && el.textContent !== text) el.textContent = text;
  };

  /** What changes around the drafts without touching what you typed: sent, the link, publishing. */
  function refresh(a) {
    if (!root() || !a) return;
    const u = a.announce ?? {};
    // Its statements checked against the work (claims.js): what to read before it goes out.
    const cl = root().querySelector('[data-upd-claims]');
    const html = claimsNote?.(a) ?? '';
    if (cl && cl.dataset.html !== html) {
      cl.innerHTML = html;
      cl.dataset.html = html;
    }
    const link = u.link ? 'The link to the details goes under it.' : 'No link to the details yet: it goes without one.';
    note('slack', `${u.sent?.slack ? `Posted ${ago(u.sent.slack)}. ` : ''}${link}`);
    note('email', `${u.sent?.email ? `Opened in mail ${ago(u.sent.email)}. ` : ''}${link}`);
    note('link', u.publishing ? 'Publishing to Google Drive… this takes a minute or two.' : u.publishError ? `Not published: ${u.publishError}` : u.link ? (u.published ? `A Google Doc, published ${ago(u.published.at)}. Publish again for a new one after changes.` : '') : 'Paste a link (a Google Doc, Confluence, the pull request), or publish the details below as a Google Doc.');
    const linkField = field('link');
    if (linkField && document.activeElement !== linkField && linkField.value !== (u.link ?? '')) linkField.value = u.link ?? '';
    const post = root().querySelector('[data-upd-act="post-slack"]');
    if (!post.dataset.sure) {
      post.disabled = slack === null;
      post.textContent = slack ? `Post to ${slack}` : 'Post to Slack';
      post.title = slack === null ? 'Slack is not set up: agentmgr announce --webhook <url> on the computer, or set up Slack alerts' : 'Post the message above, as it reads now';
    }
    root().querySelector('[data-upd-act="publish"]').disabled = Boolean(u.publishing);
    root().querySelector('[data-upd-act="dismiss"]').hidden = !updateWaits(a);
    if (slack === undefined) {
      slack = null;
      api('GET', '/announce/settings').then((s) => {
        slack = s.slack ?? null;
        refresh(agentOf(root()?.dataset.upd));
      }).catch(() => {});
    }
  }

  const copy = (text, what) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied`), () => toast('Copy failed: your browser blocked clipboard access'));
  const save = (id, patch) => api('PUT', `/agents/${id}/announce`, patch).then(upsert);

  body.addEventListener('change', (e) => {
    const id = root()?.dataset.upd;
    const k = e.target.dataset?.updText;
    if (!id || !['link', 'to'].includes(k)) return;
    save(id, { [k]: e.target.value }).catch((err) => toast(`Error: ${err.message}`, 6000));
  });

  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-upd-act]');
    const id = root()?.dataset.upd;
    if (!b || !id) return;
    const link = agentOf(id)?.announce?.link ?? null;
    const what = b.dataset.updAct;
    try {
      if (what === 'copy-slack') return await copy(withLink(field('slack').value, link), 'The Slack message');
      if (what === 'copy-email') return await copy(`Subject: ${field('subject').value}\n\n${withLink(field('email').value, link)}`, 'The email');
      if (what === 'mail') {
        // The device's own mail program sends it, from your address: this page only fills it in.
        location.href = mailtoFor(field('to').value, field('subject').value, withLink(field('email').value, link));
        return await save(id, { sent: 'email', to: field('to').value });
      }
      if (what === 'post-slack') {
        // A channel full of people: asked twice, so a slip of the thumb posts nothing.
        if (!b.dataset.sure) {
          b.dataset.sure = '1';
          b.textContent = `Post it to ${slack}?`;
          b.classList.add('primary');
          return setTimeout(() => {
            delete b.dataset.sure;
            b.classList.remove('primary');
            refresh(agentOf(id));
          }, 5000);
        }
        delete b.dataset.sure;
        b.classList.remove('primary');
        const r = await api('POST', `/agents/${id}/announce/slack`, { text: field('slack').value });
        upsert(r);
        return toast(`Posted to ${r.postedTo}`);
      }
      if (what === 'publish') return upsert(await api('POST', `/agents/${id}/announce/publish`));
      if (what === 'dismiss') {
        await save(id, { dismissed: true });
        return toast('Taken out of the inbox');
      }
    } catch (err) {
      toast(`Error: ${err.message}`, 6000);
    }
  });

  return { refresh };
}

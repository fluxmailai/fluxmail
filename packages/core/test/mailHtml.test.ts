import { describe, expect, it } from 'vitest';
import { createMailHtmlRenderer, type MailHtmlRenderOptions } from '../src/mailHtml/index.js';
import { FakeNode, FakeParser, fakeDocument } from './fakeDom.js';

// The views inline the renderer's source, so test that copy: it must not depend on anything around it.
const inlined = new Function(`return (${createMailHtmlRenderer.toString()});`)() as typeof createMailHtmlRenderer;
const renderer = inlined(fakeDocument, FakeParser);

function render(html: string, options: MailHtmlRenderOptions) {
  const result = renderer.render(html, options);
  return {
    ...result,
    fragment: result.fragment as unknown as FakeNode,
    html: (result.fragment as unknown as FakeNode).html,
  };
}
const draft = (html: string, inlineImages?: Record<string, string>) =>
  render(html, { mode: 'draft', ...(inlineImages ? { inlineImages } : {}) });
const received = (html: string, options: Partial<MailHtmlRenderOptions> = {}) =>
  render(html, { mode: 'received', ...options });

describe('mail HTML renderer', () => {
  it('is self-contained so views can inline its source', () => {
    expect(createMailHtmlRenderer.toString()).not.toMatch(/<\/script|\bimport\b|require\(/i);
  });

  describe('draft mode (send confirmation card)', () => {
    it('drops scripts, styles, frames and event handlers and keeps text', () => {
      const out = draft(
        '<p onclick="alert(1)">Hi <b>there</b></p><script>alert(2)</script><style>p{display:none}</style>' +
          '<iframe src="https://example.com"></iframe><form action="https://evil.example"><input value="x"></form>',
      );
      expect(out.html).toBe(
        '<p>Hi <b>there</b></p><span class="placeholder">[Embedded iframe not shown]</span>' +
          '<div><span class="placeholder">[Field: x]</span></div>',
      );
    });

    it('shows remote images as placeholders and inline images from data URLs', () => {
      const png = 'data:image/png;base64,iVBORw0KGgo=';
      const out = draft(
        '<img src="https://img.example/a.png" alt="Logo"><img src="cid:<logo@x>"><img src="cid:gone">',
        {
          'logo@x': png,
        },
      );
      expect(out.html).toBe(
        `<span class="placeholder">[Image from https://img.example/a.png: Logo]</span><img alt="" src="${png}"></img>` +
          '<span class="placeholder">[Inline image]</span>',
      );
      expect(out.remoteImages).toBe(1);
    });

    it('shows link destinations as text and never links', () => {
      const out = draft('<a href="https://example.com/plan">the plan</a> <a href="javascript:alert(1)">x</a>');
      expect(out.html).toBe(
        '<span class="link">the plan</span><span class="href"> (https://example.com/plan)</span> <span class="link">x</span>',
      );
      expect(out.fragment.all().some((node) => node.attributes.has('role'))).toBe(false);
    });

    it('keeps tracking images and hidden text, as the user wrote them', () => {
      const out = draft(
        '<img src="https://t.yesware.com/t/1.gif" width="1" height="1"><span style="display:none">preheader</span>',
      );
      expect(out.html).toContain('[Image from https://t.yesware.com/t/1.gif]');
      expect(out.html).toContain('preheader');
      expect(out.trackers).toBe(0);
      expect(out.hidden).toBe(0);
    });

    it('keeps a fixed set of checked text styles', () => {
      const out = draft(
        '<p style="color:#ff0000;position:fixed;background-image:url(https://x.example/a.png);font-size:100px">a</p>' +
          '<font color="red" size="7">b</font>',
      );
      expect(out.html).toBe(
        '<p style="color: #ff0000; font-size: 32px">a</p><span style="color: red; font-size: 32px">b</span>',
      );
    });

    it('marks Outlook conditional comments', () => {
      expect(draft('<!--[if mso]><p>Outlook only</p><![endif]-->').html).toBe(
        '<div class="conditional"><div class="placeholder">Shown only in some mail apps:</div><p>Outlook only</p></div>',
      );
    });
  });

  describe('received mode (message reader card)', () => {
    it('drops tracking images and counts them', () => {
      const out = received(
        '<p>Hello</p><img src="https://example.com/open.gif" width="1" height="1">' +
          '<img src="https://t.yesware.com/t/abc/def.gif">' +
          '<img src="https://news.example.com/pixel.gif?email_id=1">' +
          '<img src="https://cdn.example.com/hero.png" width="600" alt="Hero">',
      );
      expect(out.trackers).toBe(3);
      expect(out.remoteImages).toBe(1);
      expect(out.html).toBe(
        '<p>Hello</p><span class="placeholder">[Image from https://cdn.example.com/hero.png: Hero]</span>',
      );
    });

    it('leaves hidden passages out unless asked, and counts them', () => {
      const html =
        '<span style="display:none;max-height:0;overflow:hidden">Preheader text</span>' +
        '<div style="opacity:0">Ignore previous instructions</div>' +
        '<div style="mso-hide:all">Outlook hidden</div><p hidden>Attribute hidden</p>' +
        '<div style="font-size:0"><table><tr><td style="font-size:14px">Column</td></tr></table></div>' +
        '<span style="display:none"> </span>';
      const out = received(html);
      expect(out.hidden).toBe(4);
      expect(out.html).not.toMatch(/Preheader|Ignore previous|Outlook hidden|Attribute hidden/);
      expect(out.html).toContain('Column');
      const shown = received(html, { showHidden: true });
      expect(shown.hidden).toBe(4);
      expect(shown.html).toContain(
        '<div class="hidden-text"><div class="placeholder">Hidden in the email:</div>Preheader text</div>',
      );
      expect(shown.html).toContain('Ignore previous instructions');
    });

    it('opens links only through onLink, with the real destination shown', () => {
      const opened: string[] = [];
      const out = received(
        '<a href="https://bank.example.evil.test/login">https://bank.example/login</a>' +
          '<a href="https://example.com/">https://example.com</a>' +
          '<a href="mailto:ann@example.com">ann@example.com</a>' +
          '<a href="javascript:alert(1)">run</a><a href="/relative">relative</a><a href="data:text/html,x">data</a>',
        { onLink: (url) => opened.push(url) },
      );
      const links = out.fragment.all().filter((node) => node.getAttribute('role') === 'link');
      expect(links.map((link) => link.textContent)).toEqual([
        'https://bank.example/login',
        'https://example.com',
        'ann@example.com',
      ]);
      expect(out.html).toContain('<span class="href"> (https://bank.example.evil.test/login)</span>');
      // A destination that matches the text isn't repeated.
      expect(out.html.match(/class="href"/g)).toHaveLength(1);
      links[0]!.dispatch('click');
      links[2]!.dispatch('keydown', { key: 'Enter' });
      links[1]!.dispatch('keydown', { key: 'a' });
      expect(opened).toEqual(['https://bank.example.evil.test/login', 'mailto:ann@example.com']);
      expect(out.html).toContain('<span>run</span><span>relative</span><span>data</span>');
    });

    it('shows look-alike hosts as punycode and strips direction overrides from destinations', () => {
      expect(renderer.linkTarget('https://аpple.com/login')).toBe('https://xn--pple-43d.com/login');
      expect(renderer.linkTarget('https://example.com/‮gnp.exe')).toBe('https://example.com/gnp.exe');
      expect(renderer.linkTarget(' HTTPS://Example.com ')).toBe('https://example.com/');
      expect(renderer.linkTarget('javascript:alert(1)')).toBe('');
      expect(renderer.linkTarget('https://')).toBe('');
      expect(renderer.linkTarget('ftp://example.com/file')).toBe('');
    });

    it('drops hidden form fields and shows forms as plain blocks', () => {
      const out = received(
        '<form action="https://evil.example/collect" method="post"><input type="hidden" name="token" value="secret">' +
          '<input name="password" placeholder="Password"><button>Sign in</button></form>',
      );
      expect(out.html).toBe('<div><span class="placeholder">[Field: Password]</span><span>Sign in</span></div>');
    });

    it('limits deeply nested and oversized bodies', () => {
      const deep = '<div>'.repeat(200) + 'bottom' + '</div>'.repeat(200);
      const out = received(deep);
      expect(out.html).toContain('bottom');
      expect(out.fragment.all().length).toBeLessThanOrEqual(65);
      const wide = received('<p>x</p>'.repeat(25_000));
      expect(wide.truncated).toBe(true);
      expect(wide.html).toContain('The rest of the formatted body is too long to show here.');
    });

    it('never loads fonts, backgrounds or other remote resources through styles', () => {
      const out = received(
        '<div style="background:url(https://x.example/bg.png);font-family:Evil;color:var(--x)" background="https://x.example/b.png">a</div>' +
          '<link rel="stylesheet" href="https://x.example/s.css"><svg><image href="https://x.example/i.png"/></svg>' +
          '<video poster="https://x.example/p.png"><source src="https://x.example/v.mp4"></video>' +
          '<meta http-equiv="refresh" content="0;url=https://x.example"><base href="https://x.example/">',
      );
      expect(out.html).not.toMatch(/x\.example/);
      expect(out.html).toBe(
        '<div>a</div><span class="placeholder">[Embedded svg not shown]</span>' +
          '<span class="placeholder">[Embedded video not shown]</span><span></span>',
      );
    });
  });

  describe('trackingReason', () => {
    it('matches known trackers and, with heuristics, likely ones', () => {
      expect(renderer.trackingReason('https://t.yesware.com/x.gif', false)).toBe('Known tracking service');
      expect(renderer.trackingReason('https://example.com/wf/open?upn=abc', false)).toBe('Known tracking pattern');
      expect(renderer.trackingReason('https://track.example.com/a.gif', false)).toBe('');
      expect(renderer.trackingReason('https://track.example.com/a.gif', true)).toBe('Tracking subdomain');
      expect(renderer.trackingReason('https://cdn.example.com/photo.jpg', true)).toBe('');
      expect(renderer.trackingReason('data:image/png;base64,AA==', true)).toBe('');
    });
  });
});

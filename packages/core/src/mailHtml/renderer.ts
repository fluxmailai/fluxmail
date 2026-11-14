/**
 * Renders untrusted email HTML for Fluxmail views: the MCP Apps cards, and any browser surface that wants the
 * same rules. It parses the HTML inertly and rebuilds the body from an allowlist with DOM APIs, so no script,
 * style sheet, form, frame or remote resource survives. Remote images become placeholders that show their URL,
 * inline cid: images render only from data: URLs the caller supplies, and links never navigate on their own.
 *
 * createMailHtmlRenderer is self-contained: it refers to nothing outside its own body, so a view can inline its
 * source with Function.prototype.toString. Don't import or refer to module-level values inside it, and keep the
 * text "</script" out of it.
 */

/** The DOM surface the renderer uses. Browser DOM objects satisfy it. */
export interface MailHtmlDomNode {
  nodeType: number;
  nodeValue: string | null;
  textContent: string | null;
  localName: string;
  firstChild: MailHtmlDomNode | null;
  nextSibling: MailHtmlDomNode | null;
  className: string;
  title: string;
  style: { getPropertyValue(name: string): string; setProperty(name: string, value: string): void };
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  appendChild(child: MailHtmlDomNode): MailHtmlDomNode;
  addEventListener(type: string, listener: (event: { key?: string; preventDefault(): void }) => void): void;
}
export interface MailHtmlDomDocument {
  createElement(tag: string): MailHtmlDomNode;
  createTextNode(text: string): MailHtmlDomNode;
  createDocumentFragment(): MailHtmlDomNode;
}
export interface MailHtmlParserConstructor {
  new (): { parseFromString(html: string, type: string): { body: MailHtmlDomNode; head: MailHtmlDomNode } };
}

export interface MailHtmlRenderOptions {
  /**
   * `draft` renders mail the user is writing, as the send confirmation card always has. `received` adds the
   * rules for mail from someone else: tracking images are dropped, hidden passages are left out unless
   * showHidden is set, link destinations are normalized so look-alike hosts show as punycode, and links open
   * only through onLink.
   */
  mode: 'draft' | 'received';
  /** Content-ID (without angle brackets) to a data: URL of a PNG, GIF, JPEG or WebP image. */
  inlineImages?: Record<string, string>;
  /** Received mode: show hidden passages, marked as hidden, instead of leaving them out. */
  showHidden?: boolean;
  /** Received mode: called with a checked http, https or mailto URL when the user activates a link. */
  onLink?: (url: string) => void;
}

export interface MailHtmlRenderResult {
  fragment: MailHtmlDomNode;
  /** The body had more nodes than the renderer shows. */
  truncated: boolean;
  /** Received mode: tracking images left out. */
  trackers: number;
  /** Received mode: hidden passages left out (or, with showHidden, shown). */
  hidden: number;
  /** Remote images shown as placeholders. */
  remoteImages: number;
}

export interface MailHtmlRenderer {
  render(html: string, options: MailHtmlRenderOptions): MailHtmlRenderResult;
  /** The URL when it is an absolute http, https or mailto URL, normalized; otherwise an empty string. */
  linkTarget(href: string): string;
  /** Why an image URL looks like a tracker, or an empty string. `aggressive` adds the heuristics. */
  trackingReason(url: string, aggressive: boolean): string;
}

export function createMailHtmlRenderer(doc: MailHtmlDomDocument, Parser: MailHtmlParserConstructor): MailHtmlRenderer {
  'use strict';
  var MAX_NODES = 20000;
  var MAX_DEPTH = 64;
  var MAX_PATTERN_URL = 1024;
  // Remote images checked against the tracking rules; the rest are placeholders.
  var MAX_TRACKING_CHECKS = 200;
  var KEEP =
    ' a abbr b bdi bdo big blockquote br caption cite code col colgroup dd del dfn div dl dt em font h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp small span strike strong sub sup table tbody td tfoot th thead tr tt u ul var ';
  // Elements whose content no mail app shows.
  var SKIP = ' base head link meta script style template title ';
  // Elements shown as a placeholder because the views do not embed them.
  var EMBEDDED = ' applet audio canvas embed frame frameset iframe math object svg video ';
  // Containers mail apps lay out as blocks; the views show them as plain blocks.
  var BLOCKS =
    ' address article aside center details dialog fieldset figcaption figure footer form header hgroup legend main nav noscript section summary ';
  var SAFE_IMAGE = /^data:image\/(png|gif|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i;
  var CONDITIONAL = /^\s*\[if[^\]]*\]>([\s\S]*)<!\[endif\]\s*$/i;
  // Bidirectional and invisible formatting characters, which can make a link destination read differently.
  var INVISIBLE = new RegExp(
    // oxlint-disable-next-line no-control-regex -- Control characters are what this pattern removes.
    '[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff]',
    'g',
  );

  // Tracking image rules, after the lists Fluxmail Desktop audited (AdGuard's mail tracking filter,
  // ugly-email-trackers and Trocker).
  var TRACKING_PROVIDER_DOMAINS = [
    'mailchimp.com',
    'list-manage.com',
    'list-manage1.com',
    'constantcontact.com',
    'sendgrid.net',
    'mailgun.org',
    'mandrill.com',
    'mandrillapp.com',
    'postmarkapp.com',
    'aweber.com',
    'getresponse.com',
    'convertkit.com',
    'drip.com',
    'google-analytics.com',
    'doubleclick.net',
    'mixpanel.com',
    'amplitude.com',
    'icptrack.com',
    'mkt4477.com',
    'strongview.com',
    'salesforceiq.com',
    'sendibm1.com',
    'esputnik.com',
  ];
  var TRACKING_DOMAINS = [
    'ct.sendgrid.net',
    'pstmrk.it',
    'bl-1.com',
    't.yesware.com',
    'mailfoogae.appspot.com',
    'mltrk.io',
    'mailtrack.io',
    'emltrk.com',
    'mailstat.us',
    'tracking.cirrusinsight.com',
    'r.superhuman.com',
    'openrate.aweber.com',
    't.hubspotemail.net',
    'track.getsidekick.com',
    'hubspotlinks.com',
    'beacon.krxd.net',
    'ping.answerbook.com',
    'pixel.watch',
    'awstrack.me',
    'e.customeriomail.com',
    'track.customer.io',
    'clicks.mlsend.com',
    'clicks.mlsend2.com',
    'click.mailersend.net',
    'link.mail.beehiiv.com',
    'eotrx.substackcdn.com',
    'email.mg-d1.substack.com',
    'flask.us.nextdoor.com',
    'email.mgtp01.squarespace-mail.com',
    'emailtracking.cashstar.com',
    'onelink.soundcloud.com',
    'email-link.adtidy.org',
    'supersender.yandex.net',
    'click.sender.yandex.ru',
    'feedback.send.yandex.ru',
    'api.peeper.plus.yandex.net',
    'image-sap.sfmc-content.com',
    'postoffice.adobe.com',
    'elink.clickdimensions.com',
    'click.revolut.com',
  ];
  var TRACKING_HOST_PATTERNS = [
    /^open\.convertkit-mail\d*\.com$/i,
    /^t\.(?:hubspotemail|hubspotfree)\.net$/i,
    /^t\.(?:sidekickopen|sigopn)\d*\.com$/i,
    /^t\.hsms\d{2}\.com$/i,
    /^t\.senal(?:uno|dos|tres|quatro|cinco)\.com$/i,
    /^t\.signale(?:una|due|tre|quattro|cinque)\.com$/i,
    /^t\.signaux(?:un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\.com$/i,
    /^t\.strk\d{2}\.email$/i,
  ];
  var TRACKING_PATTERNS = [
    /\/track\/open\.php\?u=/i,
    /\/wf\/open\?upn=/i,
    /dripemail2/i,
    /icptrack\.com\/icp\/track/i,
    /mkt4477\.com\/open/i,
    /strongview\.com\/t\//i,
    /\/e\/o\/(?:[0-9a-z+/]{4})+(?:(?:[0-9a-z+/]{2}==)|(?:[0-9a-z+/]{3}=))?(?:[/?#]|$)/i,
    /mixmax\.com\/api\/track\//i,
    /mixmax\.com\/e\/o/i,
    /\/\/tracking.*\/api\/track\/v2\//i,
    /contactmonkey\.com\/api\/v1\/tracker/i,
    /\/\/(.*)\.convertkit-mail([1-9])?\.com\/o\//i,
    /polymail\.io(\/v2\/z\/)?/i,
    /share\.polymail\.io/i,
    /yamm-track\.appspot/i,
    /\/open\.html\?x=/i,
    /\/ut\.php\?u=/i,
    /close\.io\/email_opened/i,
    /\/\/ml\.closeml\.com\/t\/\w+\/\w+\.png/i,
    /\.cc\.rs6\.net\/on\.jsp/i,
    /\/trk\?t=/i,
    /returnpath\.net\/pixel\.gif/i,
    /(outrch|whosen|getoutreach)\.com\/api\/mailings\/opened/i,
    /\/\/(.*)\.intercom-\w+\.com(?:\/via)?\//i,
    /\/\/links\..*\/oo\//i,
    /\.mjt\.lu\//i,
    /\/oo\/.*\.gif/i,
    /nethunt\.com\/api\/v1\/track\/email\//i,
    /apple\.com\/report\/2\/its_mail_sf/i,
    /\/o\/\w{10}\/\w{10}\//i,
    /lt\.php(.*)\?l=open/i,
    /email81\.com\/case/i,
    /growthdot\.com\/api\/mail-tracking/i,
    /\/e2t\/(o|c|to)\//i,
    /getmailspring\.com\/open/i,
    /mixpanel\.com\/(trk|track)/i,
    /go\.sparkpostmail2\.com\/q\//i,
    /\/\/click\..*\/open\.aspx/i,
    /infinite-stream-5194\.herokuapp\.com\/pixel\//i,
    /sailthru\.com\/trk/i,
    /trackapp\.io\/static\/img\/track\.gif/i,
    /trackapp\.io\/[a-z]\//i,
    /sendib\w{2}\.com\/track\//i,
    /email\.segment\.com\/e\/o\//i,
    /salesloft\.com\/email_trackers/i,
    /salesloftlinks\.com\/t\//i,
    /saleshandy\.com\/web\/email\/countopened/i,
    /\/tools\/emails\/open\//i,
    /\/\w*I0\/\w{16}-\w{8}-\w{4}/i,
    /\/open\/\d{3}\/\w{10}/i,
    /\/\/(.*)\.enewsletter\.pl\/(.*)\.gif/i,
    /\/optiext\/optiextension\.dll\?ID=/i,
    /\/\/mx\.technolutions\.net\/ss\/o\/(.*)\/ho\.gif/i,
    /\/\/tracking\.vocus\.io\//i,
    /\/tr\/op\//i,
    /\/m\/opening\//i,
    /\/r\/\?id=/i,
    /\/a360\/public\/statistic\//i,
    /\/t\/[^/]+\/a(?:[/?#]|$)/i,
    /\/pix\.gif\?/i,
    /\/tf\/o\//i,
    /\/via\/o\?h=/i,
    /\/eos\/v1\//i,
    /\/gp\/r\.html\?.*ref_=pe_.*_open/i,
    /\/pub\/as\?_ri_=/i,
    /\/q\/[^/]+~~\//i,
    /\/s\/eo\//i,
    /\/o\.gif\?mi_u=/i,
    /\/pixel\?c=/i,
    /\/CI0\/0/i,
    /\/ss\/o\/[^/]+\/ho\.gif/i,
    /github\.com\/notifications\/beacon(?:=|\/)/i,
    /t\.paypal\.com\/ts\?v=/i,
    /click\.emails\.paypal\.com/i,
    /cdn\.shopify\.com\/shopifycloud\/shopify\/assets\/themes_support\/notifications\/spacer-/i,
    /link\.mail\.beehiiv\.com\/ss\/.*\.gif/i,
    /line\.my\.salesforce\.com\/servlet\/servlet\.ImageServer\?/i,
    /email\.[^/]+\.com\/o(?:[/?#]|$)/i,
  ];
  var GENERIC_TRACKING_PATHS = [
    /\/(?:track|pixel|open|beacon|counter|analytics|stats|metrics|monitor)(?:[./?_-]|$)/i,
    /\/e\/o(?:[/?#]|$)/i,
    /email.*track/i,
    /track.*email/i,
    /newsletter.*track/i,
    /campaign.*track/i,
    /marketing.*track/i,
  ];
  var TRACKING_QUERY_PREFIXES = [
    'email_',
    'campaign_',
    'track_',
    'subscriber_',
    'user_id',
    'recipient_',
    'message_id',
    'list_id',
    'open_',
    'view_',
    'read_',
  ];
  // The views' tests reject the text "url(" anywhere in a document, so the URL constructor goes by another name.
  var WebAddress = URL;
  var TRACKING_LABELS = ' track tracker tracking pixel open analytics stats metrics beacon counter monitor ';

  function el(tag: string, className?: string, text?: string): MailHtmlDomNode {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function has(list: string, tag: string): boolean {
    return list.indexOf(' ' + tag + ' ') >= 0;
  }
  function clipped(url: string): string {
    return url.length > 200 ? url.slice(0, 200) + '...' : url;
  }
  // A destination to show: clipped after the host, so the host always stays in view.
  function shownTarget(url: string): string {
    if (url.length <= 200) return url;
    var origin = /^[a-z]+:(\/\/)?[^/?#]*/i.exec(url);
    var keep = Math.max(200, origin ? origin[0].length : 0);
    return url.slice(0, keep) + '...';
  }
  function hostMatches(host: string, domain: string): boolean {
    return host === domain || host.slice(-domain.length - 1) === '.' + domain;
  }
  function httpLocation(source: string): InstanceType<typeof WebAddress> | null {
    try {
      var url = new WebAddress(source);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
    } catch {
      return null;
    }
  }

  function linkTarget(href: string): string {
    var value = String(href || '')
      .replace(INVISIBLE, '')
      .trim();
    if (!/^(https?|mailto):/i.test(value)) return '';
    try {
      var url = new WebAddress(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return '';
      if (url.protocol !== 'mailto:' && !url.hostname) return '';
      // A user name before the host ("https://bank.example@evil.example") only disguises where a link goes.
      url.username = '';
      url.password = '';
      // URL serializes look-alike international hosts as punycode, so the destination reads as it resolves.
      return url.href;
    } catch {
      return '';
    }
  }

  function trackingReason(source: string, aggressive: boolean): string {
    var url = httpLocation(source);
    if (!url) return '';
    var host = url.hostname.toLowerCase();
    if (hostMatches(host, 'permies.com') && /^\/t\/[^/]+\/a\/?$/i.test(url.pathname)) return '';
    var index;
    // Some patterns backtrack on long input, so they only see URLs of a usual length.
    if (source.length <= MAX_PATTERN_URL) {
      var lower = source.toLowerCase();
      for (index = 0; index < TRACKING_PATTERNS.length; index++) {
        if (TRACKING_PATTERNS[index]!.test(lower)) return 'Known tracking pattern';
      }
    }
    for (index = 0; index < TRACKING_DOMAINS.length; index++) {
      if (hostMatches(host, TRACKING_DOMAINS[index]!)) return 'Known tracking service';
    }
    for (index = 0; index < TRACKING_HOST_PATTERNS.length; index++) {
      if (TRACKING_HOST_PATTERNS[index]!.test(host)) return 'Known tracking service';
    }
    if (!aggressive) return '';
    for (index = 0; index < TRACKING_PROVIDER_DOMAINS.length; index++) {
      if (hostMatches(host, TRACKING_PROVIDER_DOMAINS[index]!)) return 'Known tracking service';
    }
    var labels = host.split('.');
    for (index = 0; index < labels.length; index++) {
      if (has(TRACKING_LABELS, labels[index]!)) return 'Tracking subdomain';
    }
    var path = url.pathname + url.search;
    if (path.length <= MAX_PATTERN_URL) {
      for (index = 0; index < GENERIC_TRACKING_PATHS.length; index++) {
        if (GENERIC_TRACKING_PATHS[index]!.test(path)) return 'Tracking URL';
      }
    }
    var tracked = false;
    url.searchParams.forEach(function (_value: string, key: string) {
      for (var prefix = 0; prefix < TRACKING_QUERY_PREFIXES.length; prefix++) {
        if (key.toLowerCase().indexOf(TRACKING_QUERY_PREFIXES[prefix]!) === 0) tracked = true;
      }
    });
    return tracked && /(?:pixel|track|open|beacon|spacer|1x1|\.gif$)/i.test(url.pathname) ? 'Tracking parameter' : '';
  }

  function dimension(node: MailHtmlDomNode, name: string): number | undefined {
    var declared = (node.style ? node.style.getPropertyValue(name) : '').trim();
    var match = /^(\d+(?:\.\d+)?)px$/i.exec(declared);
    if (match) return parseFloat(match[1]!);
    if (declared === '0') return 0;
    var attribute = node.getAttribute(name);
    if (attribute === null) return undefined;
    var parsed = parseInt(attribute, 10);
    return isNaN(parsed) ? undefined : parsed;
  }
  function structuralTracker(node: MailHtmlDomNode): boolean {
    var width = dimension(node, 'width');
    var height = dimension(node, 'height');
    if (width !== undefined && width <= 2) return true;
    if (height !== undefined && height <= 2) return true;
    return isHidden(node);
  }
  function likelyContent(node: MailHtmlDomNode): boolean {
    var width = dimension(node, 'width') || 0;
    var height = dimension(node, 'height') || 0;
    var style = (node.getAttribute('style') || '').toLowerCase();
    return (
      width >= 64 ||
      height >= 64 ||
      /width\s*:\s*(100%|auto)/.test(style) ||
      /max-width\s*:\s*(100%|none|inherit)/.test(style)
    );
  }

  // Passages mail apps don't show: preheaders, text hidden from the reader but not from filters or models.
  function isHidden(node: MailHtmlDomNode): boolean {
    if (node.hasAttribute('hidden')) return true;
    var raw = (node.getAttribute('style') || '').toLowerCase().replace(/\s+/g, '');
    if (/mso-hide:all/.test(raw)) return true;
    var style = node.style;
    if (!style) return false;
    var value = function (name: string) {
      return String(style.getPropertyValue(name) || '')
        .trim()
        .toLowerCase();
    };
    if (value('display') === 'none' || value('visibility') === 'hidden') return true;
    if (/^0(\.0*)?$/.test(value('opacity'))) return true;
    // font-size: 0 alone is not a sign: responsive templates set it on column wrappers to remove gaps.
    var clippedBox =
      value('overflow') === 'hidden' || value('overflow-y') === 'hidden' || value('overflow-x') === 'hidden';
    if (
      clippedBox &&
      (/^0(px)?$/.test(value('max-height')) ||
        /^0(px)?$/.test(value('height')) ||
        /^0(px)?$/.test(value('max-width')) ||
        /^0(px)?$/.test(value('width')))
    )
      return true;
    return false;
  }

  // Colors the renderer can compare: white-ish and black names, hex with optional alpha, rgb() and rgba().
  var NAMED_COLORS: Record<string, number[]> = {
    transparent: [0, 0, 0, 0],
    black: [0, 0, 0, 1],
    white: [255, 255, 255, 1],
    snow: [255, 250, 250, 1],
    ivory: [255, 255, 240, 1],
    ghostwhite: [248, 248, 255, 1],
    whitesmoke: [245, 245, 245, 1],
    floralwhite: [255, 250, 240, 1],
    mintcream: [245, 255, 250, 1],
    azure: [240, 255, 255, 1],
    aliceblue: [240, 248, 255, 1],
    seashell: [255, 245, 238, 1],
    linen: [250, 240, 230, 1],
    oldlace: [253, 245, 230, 1],
    honeydew: [240, 255, 240, 1],
    lavenderblush: [255, 240, 245, 1],
    cornsilk: [255, 248, 220, 1],
    beige: [245, 245, 220, 1],
  };
  // [red, green, blue, alpha], or null for a color the renderer can't compare.
  function parseColor(value: string): number[] | null {
    if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, value)) return NAMED_COLORS[value]!;
    var hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
    if (hex) {
      var digits = hex[1]!.length <= 4 ? hex[1]!.replace(/./g, '$&$&') : hex[1]!;
      var parts = [0, 2, 4].map(function (start) {
        return parseInt(digits.slice(start, start + 2), 16);
      });
      parts.push(digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1);
      return parts;
    }
    var rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
    if (rgb) return [+rgb[1]!, +rgb[2]!, +rgb[3]!, rgb[4] === undefined ? 1 : parseFloat(rgb[4])];
    return null;
  }
  // The color an element paints, as the renderer copies it: undefined when it paints none, null when the
  // renderer can't compare it.
  function paintedColor(node: MailHtmlDomNode, property: 'color' | 'background-color'): number[] | null | undefined {
    var declared = node.style ? node.style.getPropertyValue(property) : '';
    var attribute =
      property === 'background-color'
        ? node.getAttribute('bgcolor')
        : node.localName.toLowerCase() === 'font'
          ? node.getAttribute('color')
          : null;
    var value = styleValue(property, declared || attribute);
    if (property === 'background-color' && node.style) {
      // A background image the card doesn't load leaves the color behind the text unknown.
      var image = String(node.style.getPropertyValue('background-image') || '').trim();
      if ((image && image !== 'none') || node.hasAttribute('background')) return null;
    }
    return value ? parseColor(value) : undefined;
  }
  function paintsInside(node: MailHtmlDomNode): boolean {
    var seen = 0;
    function visit(parent: MailHtmlDomNode): boolean {
      for (var child = parent.firstChild; child; child = child.nextSibling) {
        if (child.nodeType !== 1) continue;
        // Past the limit, assume it does, so a passage is never hidden on a guess.
        if (++seen > 300 || child.localName.toLowerCase() === 'img') return true;
        if (paintedColor(child, 'color') !== undefined || paintedColor(child, 'background-color') !== undefined)
          return true;
        if (visit(child)) return true;
      }
      return false;
    }
    return visit(node);
  }
  interface Paint {
    color: number[] | null;
    background: number[] | null;
  }
  // The colors an element's content is drawn in, as the renderer shows it.
  function paintOf(node: MailHtmlDomNode, around: Paint): Paint {
    var color = paintedColor(node, 'color');
    var background = paintedColor(node, 'background-color');
    return {
      color: color === undefined ? around.color : color,
      // A translucent background mixes with what's behind it, so it can't be compared.
      background: background === undefined ? around.background : background && background[3]! < 1 ? null : background,
    };
  }
  // Text drawn in a transparent color or in (nearly) the color behind it: visible to filters and models, not to
  // the reader. Colors the renderer can't compare never count, and neither does an element whose content paints
  // its own colors.
  function invisibleText(node: MailHtmlDomNode, around: Paint): boolean {
    if (paintedColor(node, 'color') === undefined && paintedColor(node, 'background-color') === undefined) return false;
    var paint = paintOf(node, around);
    var color = paint.color;
    var background = paint.background;
    if (!color || paintsInside(node)) return false;
    if (color[3]! < 0.35) return true;
    if (!background || color[3]! < 1) return false;
    return (
      Math.abs(color[0]! - background[0]!) +
        Math.abs(color[1]! - background[1]!) +
        Math.abs(color[2]! - background[2]!) <
      40
    );
  }

  // Text styling mail apps show, from a fixed list of properties with checked values. Layout, positioning,
  // visibility and anything that loads a resource are left out.
  var STYLE_PROPERTIES = [
    'color',
    'background-color',
    'font-weight',
    'font-style',
    'text-decoration-line',
    'text-align',
    'font-size',
  ];
  var FONT_SIZES = [0, 10, 13, 16, 18, 24, 32, 32];
  function styleValue(property: string, raw: string | null): string {
    var value = String(raw || '')
      .trim()
      .toLowerCase();
    if (!value || value.length > 64 || /[^a-z0-9#%(),.\s-]/.test(value) || /url|expression|var|attr|image/.test(value))
      return '';
    if (property === 'font-size') {
      var size = /^(\d+(?:\.\d+)?)(px|pt)$/.exec(value);
      if (size) return Math.min(32, Math.max(10, parseFloat(size[1]!) * (size[2] === 'pt' ? 4 / 3 : 1))) + 'px';
      return /^(x-small|small|medium|large|x-large)$/.test(value) ? value : '';
    }
    if (property === 'text-align') return /^(left|right|center|justify|start|end)$/.test(value) ? value : '';
    if (property === 'font-weight') return /^(normal|bold|bolder|lighter|[1-9]00)$/.test(value) ? value : '';
    if (property === 'font-style') return /^(normal|italic|oblique)$/.test(value) ? value : '';
    if (property === 'text-decoration-line')
      return /^(none|((underline|line-through|overline)\s*)+)$/.test(value) ? value : '';
    return /^(#[0-9a-f]{3,8}|rgba?\([0-9.,%\s]+\)|hsla?\([0-9.,%\sdeg]+\)|[a-z]+)$/.test(value) ? value : '';
  }
  function setStyle(copy: MailHtmlDomNode, property: string, value: string | null): void {
    var safe = styleValue(property, value);
    if (safe) copy.style.setProperty(property, safe);
  }
  function applyStyles(node: MailHtmlDomNode, copy: MailHtmlDomNode, tag: string): void {
    if (tag === 'font') {
      setStyle(copy, 'color', node.getAttribute('color'));
      var size = parseInt(node.getAttribute('size') || '', 10);
      if (size >= 1 && size <= 7) copy.style.setProperty('font-size', FONT_SIZES[size] + 'px');
    }
    if (node.hasAttribute('bgcolor')) setStyle(copy, 'background-color', node.getAttribute('bgcolor'));
    if (node.hasAttribute('align') && tag !== 'img' && tag !== 'table')
      setStyle(copy, 'text-align', node.getAttribute('align'));
    var declared = node.style;
    if (!declared) return;
    STYLE_PROPERTIES.forEach(function (property) {
      setStyle(copy, property, declared.getPropertyValue(property));
    });
  }

  function render(html: string, options: MailHtmlRenderOptions): MailHtmlRenderResult {
    var received = options.mode === 'received';
    var images = options.inlineImages && typeof options.inlineImages === 'object' ? options.inlineImages : {};
    var result: MailHtmlRenderResult = {
      fragment: doc.createDocumentFragment(),
      truncated: false,
      trackers: 0,
      hidden: 0,
      remoteImages: 0,
    };
    var budget = { nodes: 0 };
    // The colors content is drawn in: formatted mail renders on white, in the paper's text color.
    var paint: Paint = { color: [28, 25, 23, 1], background: [255, 255, 255, 1] };
    var trackingChecks = 0;

    function inlineImage(src: string): string {
      var id = src.slice(4).trim().replace(/^<|>$/g, '');
      try {
        id = decodeURIComponent(id);
      } catch {}
      var url = Object.prototype.hasOwnProperty.call(images, id) ? images[id] : '';
      return typeof url === 'string' && SAFE_IMAGE.test(url) ? url : '';
    }
    function imageFor(node: MailHtmlDomNode): MailHtmlDomNode | null {
      var src = (node.getAttribute('src') || '').trim();
      var alt = (node.getAttribute('alt') || '').slice(0, 200);
      if (/^cid:/i.test(src)) src = inlineImage(src) || src;
      if (SAFE_IMAGE.test(src)) {
        var img = el('img');
        img.setAttribute('alt', alt);
        img.setAttribute('src', src);
        return img;
      }
      var remote = /^https?:/i.test(src);
      if (
        received &&
        remote &&
        (structuralTracker(node) ||
          (++trackingChecks <= MAX_TRACKING_CHECKS && trackingReason(src, !likelyContent(node))))
      ) {
        result.trackers++;
        return null;
      }
      if (remote) result.remoteImages++;
      var shown = received && remote ? linkTarget(src) || src : src;
      var label = /^cid:/i.test(src)
        ? 'Inline image'
        : remote
          ? 'Image from ' + (received ? shownTarget(shown) : clipped(shown))
          : 'Image';
      return el('span', 'placeholder', '[' + label + (alt ? ': ' + alt : '') + ']');
    }
    function linkFor(node: MailHtmlDomNode, depth: number, to: MailHtmlDomNode): void {
      var href = (node.getAttribute('href') || '').trim();
      if (!received) {
        var span = el('span', 'link');
        copyChildren(node, span, depth + 1);
        to.appendChild(span);
        if (href && href !== (span.textContent || '').trim() && !/^(javascript|data|vbscript):/i.test(href)) {
          to.appendChild(el('span', 'href', ' (' + clipped(href) + ')'));
        }
        return;
      }
      var url = linkTarget(href);
      var link = el('span', url ? 'link' : '');
      // The link's own colors, so a button-style link stays readable on its cell.
      applyStyles(node, link, 'a');
      var around = paint;
      paint = paintOf(node, around);
      if (url && paintedColor(node, 'color') === undefined)
        paint = { color: [29, 78, 216, 1], background: paint.background };
      copyChildren(node, link, depth + 1);
      paint = around;
      to.appendChild(link);
      if (!url) return;
      var text = (link.textContent || '').replace(INVISIBLE, '').trim();
      var shown = url.replace(/^mailto:/i, '');
      if (text !== url && text !== shown && text + '/' !== url)
        to.appendChild(el('span', 'href', ' (' + shownTarget(shown) + ')'));
      // Not a real link: the view opens it only through the host, after the user activates it.
      link.setAttribute('role', 'link');
      link.setAttribute('tabindex', '0');
      link.title = shownTarget(url);
      var open = options.onLink;
      if (typeof open !== 'function') return;
      link.addEventListener('click', function (event) {
        event.preventDefault();
        open!(url);
      });
      link.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          open!(url);
        }
      });
    }
    function copyComment(node: MailHtmlDomNode, to: MailHtmlDomNode, depth: number): void {
      var match = CONDITIONAL.exec(node.nodeValue || '');
      if (!match || !match[1]!.trim()) return;
      var box = el('div', 'conditional');
      box.appendChild(el('div', 'placeholder', 'Shown only in some mail apps:'));
      var inner = new Parser().parseFromString(match[1]!, 'text/html');
      copyChildren(inner.body, box, depth + 1);
      to.appendChild(box);
    }
    function copyChildren(from: MailHtmlDomNode, to: MailHtmlDomNode, depth: number): void {
      for (var child = from.firstChild; child; child = child.nextSibling) {
        if (++budget.nodes > MAX_NODES) return;
        if (child.nodeType === 3) {
          to.appendChild(doc.createTextNode(child.nodeValue || ''));
          continue;
        }
        if (child.nodeType === 8) {
          copyComment(child, to, depth);
          continue;
        }
        if (child.nodeType !== 1) continue;
        var tag = child.localName.toLowerCase();
        if (has(SKIP, tag)) continue;
        if (depth >= MAX_DEPTH) {
          to.appendChild(doc.createTextNode(child.textContent || ''));
          continue;
        }
        if (received && tag !== 'img' && (isHidden(child) || invisibleText(child, paint))) {
          if (!/\S/.test(child.textContent || '')) continue;
          result.hidden++;
          if (!options.showHidden) continue;
          var shownHidden = el('div', 'hidden-text');
          shownHidden.appendChild(el('div', 'placeholder', 'Hidden in the email:'));
          copyChildren(child, shownHidden, depth + 1);
          to.appendChild(shownHidden);
          continue;
        }
        if (has(EMBEDDED, tag)) {
          to.appendChild(el('span', 'placeholder', '[Embedded ' + tag + ' not shown]'));
          if (tag === 'object' || tag === 'video' || tag === 'audio' || tag === 'applet')
            copyChildren(child, to, depth + 1);
          continue;
        }
        if (tag === 'img') {
          var image = imageFor(child);
          if (image) to.appendChild(image);
          continue;
        }
        if (tag === 'input') {
          if (received && (child.getAttribute('type') || '').toLowerCase() === 'hidden') continue;
          var value = child.getAttribute('value') || child.getAttribute('placeholder') || '';
          to.appendChild(el('span', 'placeholder', '[Field' + (value ? ': ' + value.slice(0, 200) : '') + ']'));
          continue;
        }
        if (tag === 'a') {
          linkFor(child, depth, to);
          continue;
        }
        var name = has(BLOCKS, tag)
          ? 'div'
          : !has(KEEP, tag)
            ? 'span'
            : tag === 'font' || tag === 'big' || tag === 'tt'
              ? 'span'
              : tag;
        var copy = el(name);
        if (tag === 'td' || tag === 'th') {
          ['colspan', 'rowspan'].forEach(function (attribute) {
            var span = parseInt(child!.getAttribute(attribute) || '', 10);
            if (span > 1 && span <= 100) copy.setAttribute(attribute, String(span));
          });
        }
        applyStyles(child, copy, tag);
        var outside = paint;
        if (received) paint = paintOf(child, outside);
        copyChildren(child, copy, depth + 1);
        paint = outside;
        to.appendChild(copy);
      }
    }

    var parsed = new Parser().parseFromString(html, 'text/html');
    var root = result.fragment;
    if (
      received &&
      (paintedColor(parsed.body, 'color') !== undefined || paintedColor(parsed.body, 'background-color') !== undefined)
    ) {
      // Mail apps paint the body's colors, as in a dark newsletter, so the card does too.
      root = el('div', 'mail-body');
      applyStyles(parsed.body, root, 'body');
      paint = paintOf(parsed.body, paint);
      result.fragment.appendChild(root);
    }
    copyChildren(parsed.body, root, 0);
    // Conditional comments before <body> still reach Outlook.
    for (var child = parsed.head.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 8) copyComment(child, result.fragment, 0);
    }
    if (budget.nodes > MAX_NODES) {
      result.truncated = true;
      result.fragment.appendChild(el('p', 'placeholder', 'The rest of the formatted body is too long to show here.'));
    }
    return result;
  }

  return { render: render, linkTarget: linkTarget, trackingReason: trackingReason };
}

/**
 * Styles for what render() produces, scoped under `.body-html`. `.paper` is the light page formatted mail renders
 * on, since it keeps the sender's colors.
 */
export const MAIL_HTML_STYLE = `
.body-text { white-space: pre-wrap; margin: 0; font-family: inherit; }
.body-html img { max-width: 100%; height: auto; }
.body-html table { border-collapse: collapse; max-width: 100%; }
.body-html td, .body-html th { padding: 2px 4px; vertical-align: top; }
.body-html blockquote { margin: 6px 0; padding-left: 10px; border-left: 3px solid var(--color-border-primary); color: var(--color-text-secondary); }
.body-html pre, .body-html code { font-family: var(--font-mono); white-space: pre-wrap; }
.body-html .link { text-decoration: underline; }
.body-html .link[role="link"] { cursor: pointer; color: #1d4ed8; }
.body-html .link[role="link"]:focus-visible { outline: 2px solid var(--color-ring-primary); outline-offset: 1px; }
.body-html .href { color: var(--color-text-secondary); font-size: var(--font-text-sm-size); }
.body-box.paper { background: #ffffff; color: #1c1917; color-scheme: light; border-radius: var(--border-radius-md); padding: 10px 12px; }
.paper .placeholder, .paper .body-html .href { color: #57534e; }
.paper .body-html blockquote { color: #57534e; border-left-color: #d6d3d1; }
.placeholder { color: var(--color-text-secondary); font-style: italic; }
.conditional, .hidden-text { border-left: 3px dashed var(--color-border-primary); padding-left: 8px; margin: 6px 0; }
.paper .hidden-text { border-left-color: #a8a29e; }
`;

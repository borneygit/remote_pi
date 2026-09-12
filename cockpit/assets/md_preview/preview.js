/* Pipeline do preview de markdown (plano 58) — receita VS Code:
   markdown-it (GFM) → DOMPurify (allowlist) → rewrite de imagens relativas
   pro scheme controlado → morphdom (diff de DOM, preserva scroll).
   API chamada pelo Dart: window.__cockpit.setContent(md, docDir) e
   window.__cockpit.setTheme(vars). */
(function () {
  "use strict";

  var md = window.markdownit({
    html: true, // HTML embutido entra cru aqui; quem filtra é o DOMPurify
    linkify: true,
    typographer: false,
  });

  // Allowlist do DOMPurify: default seguro + alvos comuns de README.
  var SANITIZE = {
    USE_PROFILES: { html: true },
    ADD_TAGS: ["details", "summary"],
    // "checked"/"disabled" preservam o checkbox de task list do GFM
    ADD_ATTR: ["align", "width", "height", "open", "checked", "disabled"],
    FORBID_TAGS: ["style", "form", "button"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  };

  function rewriteImages(root, docDir) {
    var imgs = root.querySelectorAll("img");
    for (var i = 0; i < imgs.length; i++) {
      var src = imgs[i].getAttribute("src") || "";
      if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) {
        // scheme explícito: só data: sobrevive (CSP bloqueia o resto)
        continue;
      }
      var abs = src.charAt(0) === "/" ? src : docDir + "/" + src;
      imgs[i].setAttribute("src", "ckp-res://local/" + encodeURIComponent(abs));
    }
  }

  /* Frontmatter YAML no topo do documento (--- ... ---), o cabeçalho de
     SKILL.md/agent.md. Sem este passo o markdown-it via um <hr> seguido de
     texto solto, e o bloco aparecia derretido no meio do conteúdo.

     As regras são as MESMAS do lado Flutter (MarkdownFrontmatter.split, em
     core/ui/widgets/markdown_frontmatter.dart), pra os dois caminhos de
     preview não discordarem sobre o que é frontmatter: abertura exatamente
     `---`, fechamento `---` ou `...`, e só conta como frontmatter se render
     ao menos um campo — senão `---\n\n---` (duas linhas horizontais)
     seria engolido. */
  function splitFrontmatter(source) {
    var text = source.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
    var lead = /^[ \t\n]*/.exec(text)[0];
    var candidate = text.slice(lead.length);
    if (candidate.slice(0, 3) !== "---") return null;
    var lines = candidate.split("\n");
    if (lines[0].replace(/\s+$/, "") !== "---") return null;
    var close = -1;
    for (var i = 1; i < lines.length; i++) {
      var t = lines[i].replace(/\s+$/, "");
      if (t === "---" || t === "...") {
        close = i;
        break;
      }
    }
    if (close < 0) return null;
    var fields = parseFields(lines.slice(1, close));
    if (!fields.length) return null;
    return { fields: fields, body: lines.slice(close + 1).join("\n") };
  }

  /* Subconjunto de YAML que aparece em frontmatter: `chave: valor` no nível
     de cima, com listas em bloco (`- item`) e continuações indentadas
     coladas ao valor da chave anterior. Não é um parser de YAML — o que ele
     não entende vira texto, que é melhor do que sumir da tela. */
  function parseFields(lines) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim() || line.trim().charAt(0) === "#") continue;
      if (/^\s/.test(line) && out.length) {
        // Continuação (item de lista, mapa aninhado): acumula na chave atual.
        var cont = line.trim().replace(/^-\s*/, "");
        out[out.length - 1].value += out[out.length - 1].value ? ", " + cont : cont;
        continue;
      }
      var sep = line.indexOf(":");
      if (sep < 1) continue;
      out.push({
        key: line.slice(0, sep).trim(),
        value: unquote(line.slice(sep + 1).trim()),
      });
    }
    return out;
  }

  function unquote(v) {
    if (v.length > 1) {
      var f = v.charAt(0);
      if ((f === '"' || f === "'") && v.charAt(v.length - 1) === f) {
        return v.slice(1, -1);
      }
    }
    return v;
  }

  /* Tabela chave/valor, o mesmo formato do MarkdownFrontmatterTable no
     Flutter. Montada por DOM + textContent (nunca innerHTML): o conteúdo vem
     do documento e não passa pelo DOMPurify daqui. */
  function frontmatterTable(fields) {
    var table = document.createElement("table");
    table.className = "ckp-frontmatter";
    var body = document.createElement("tbody");
    for (var i = 0; i < fields.length; i++) {
      var row = document.createElement("tr");
      var k = document.createElement("th");
      k.textContent = fields[i].key;
      var v = document.createElement("td");
      v.textContent = fields[i].value;
      row.appendChild(k);
      row.appendChild(v);
      body.appendChild(row);
    }
    table.appendChild(body);
    return table;
  }

  /* ---- Mermaid ----------------------------------------------------------
     Blocos ```mermaid viram SVG ANTES do morphdom, na árvore `next`: assim o
     diff de DOM preserva scroll e não pisca a cada tecla. O SVG é cacheado
     por texto-fonte, então só o diagrama editado é re-renderizado. Tema
     (dark/default) segue a luminância do fundo do app; trocar o tema limpa
     o cache e re-renderiza o último conteúdo. Erro de sintaxe mostra a
     fonte com a mensagem, em vez de sumir com o bloco. */
  var mermaidReady = false;
  var mermaidDark = false;
  var mermaidCache = {};
  var mermaidSeq = 0;
  var renderSeq = 0;
  var last = null;

  function ensureMermaid() {
    if (!window.mermaid) return false;
    if (!mermaidReady) {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: mermaidDark ? "dark" : "default",
      });
      mermaidReady = true;
    }
    return true;
  }

  function mermaidBlocks(root) {
    var out = [];
    var codes = root.querySelectorAll("pre > code.language-mermaid");
    for (var i = 0; i < codes.length; i++) out.push(codes[i].parentNode);
    return out;
  }

  function renderMermaid(source) {
    if (Object.prototype.hasOwnProperty.call(mermaidCache, source)) {
      return Promise.resolve(mermaidCache[source]);
    }
    var id = "ckp-mermaid-" + ++mermaidSeq;
    return window.mermaid
      .render(id, source)
      .then(function (res) {
        mermaidCache[source] = { svg: res.svg };
        return mermaidCache[source];
      })
      .catch(function (e) {
        // mermaid deixa um <div id> órfão no body quando falha.
        var orphan = document.getElementById("d" + id);
        if (orphan) orphan.remove();
        mermaidCache[source] = { error: String((e && e.message) || e) };
        return mermaidCache[source];
      });
  }

  function replaceMermaid(pre, source, result) {
    var box = document.createElement("div");
    box.className = "ckp-mermaid";
    if (result.svg) {
      box.innerHTML = result.svg;
    } else {
      box.className += " ckp-mermaid-error";
      var code = document.createElement("pre");
      code.textContent = source;
      var msg = document.createElement("p");
      msg.className = "ckp-mermaid-msg";
      msg.textContent = result.error;
      box.appendChild(code);
      box.appendChild(msg);
    }
    pre.parentNode.replaceChild(box, pre);
  }

  function render(markdown, docDir) {
    var seq = ++renderSeq;
    var front = splitFrontmatter(markdown);
    var html = md.render(front ? front.body : markdown);
    var clean = window.DOMPurify.sanitize(html, SANITIZE);
    var next = document.createElement("div");
    next.id = "content";
    next.innerHTML = clean;
    if (front) next.insertBefore(frontmatterTable(front.fields), next.firstChild);
    rewriteImages(next, docDir);
    var pres = ensureMermaid() ? mermaidBlocks(next) : [];
    var jobs = pres.map(function (pre) {
      var source = pre.firstChild.textContent;
      return renderMermaid(source).then(function (result) {
        replaceMermaid(pre, source, result);
      });
    });
    return Promise.all(jobs).then(function () {
      // Conteúdo mais novo já chegou enquanto os diagramas renderizavam.
      if (seq !== renderSeq) return;
      var cur = document.getElementById("content");
      // Diff de DOM: só os nós que mudaram trocam — sem piscar, sem perder scroll.
      window.morphdom(cur, next);
    });
  }

  function isDark(vars) {
    var bg = vars["--ckp-bg"];
    if (!bg || bg.length !== 7) return mermaidDark;
    var r = parseInt(bg.slice(1, 3), 16) / 255;
    var g = parseInt(bg.slice(3, 5), 16) / 255;
    var b = parseInt(bg.slice(5, 7), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
  }

  window.__cockpit = {
    setContent: function (markdown, docDir) {
      last = { markdown: markdown, docDir: docDir || "" };
      render(markdown, docDir || "").catch(function (e) {
        var cur = document.getElementById("content");
        cur.textContent = String((e && e.message) || e);
      });
    },
    setTheme: function (vars) {
      var root = document.documentElement;
      for (var k in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, k)) {
          root.style.setProperty(k, vars[k]);
        }
      }
      var dark = isDark(vars);
      if (dark !== mermaidDark) {
        mermaidDark = dark;
        mermaidReady = false; // re-initialize com o tema novo
        mermaidCache = {};
        if (last) window.__cockpit.setContent(last.markdown, last.docDir);
      }
    },
  };
})();

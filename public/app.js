(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = { snapshot: null, filter: "all", search: "", loading: true, noticeTimer: null, refreshTimer: null };
  const sourceRows = $("source-rows");
  const copyRows = $("copy-rows");
  const positionsList = $("positions-list");
  const patternsList = $("patterns-list");

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setText(id, value) {
    const node = $(id);
    if (node) node.textContent = value === undefined || value === null || value === "" ? "—" : String(value);
  }

  function finite(value) {
    return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  }

  function money(value, digits = 2) {
    if (!finite(value)) return "—";
    const amount = Number(value);
    return `${amount < 0 ? "−" : ""}$${Math.abs(amount).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }

  function amount(value, digits = 2) {
    if (!finite(value)) return "—";
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
  }

  function compactAddress(value) {
    const text = value === undefined || value === null ? "" : String(value);
    return text.length > 30 ? `${text.slice(0, 13)}…${text.slice(-11)}` : (text || "—");
  }

  function formatTime(value, seconds = false) {
    if (value === undefined || value === null || value === "") return "—";
    const numericValue = typeof value === "number" ||
      (typeof value === "string" && /^\d+(\.\d+)?$/.test(value))
      ? Number(value)
      : null;
    const date = new Date(numericValue !== null && numericValue < 1e12 ? numericValue * 1000 : value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) }).format(date);
  }

  function signedClass(node, value) {
    node.classList.toggle("negative", finite(value) && Number(value) < 0);
  }

  function setConnection(kind, text) {
    const status = document.querySelector(".feed-status");
    status.classList.remove("connected", "disconnected");
    if (kind) status.classList.add(kind);
    setText("connection-text", text);
  }

  function showNotice(message) {
    const notice = $("notice");
    notice.textContent = message;
    notice.classList.add("visible");
    window.clearTimeout(state.noticeTimer);
    state.noticeTimer = window.setTimeout(() => notice.classList.remove("visible"), 3600);
  }

  function showError(message) {
    let banner = $("error-banner");
    if (!banner) {
      banner = el("div", "error-banner");
      banner.id = "error-banner";
      const messageNode = el("span", "error-copy");
      messageNode.id = "error-copy";
      const retry = el("button", "error-retry", "Retry");
      retry.type = "button";
      retry.addEventListener("click", () => loadSnapshot(true));
      banner.append(messageNode, retry);
      document.querySelector("main").prepend(banner);
    }
    $("error-copy").textContent = message;
  }

  function clearError() {
    const banner = $("error-banner");
    if (banner) banner.remove();
  }

  function renderSummary(snapshot) {
    const summary = snapshot.summary || {};
    const moneyIds = [
      ["paper-balance", summary.paperBalance],
      ["total-pnl", summary.totalPnl],
      ["realized-pnl", summary.realizedPnl],
      ["unrealized-pnl", summary.unrealizedPnl]
    ];
    for (const [id, value] of moneyIds) {
      setText(id, money(value));
      signedClass($(id), value);
    }
    setText("win-rate", finite(summary.winRate) ? `${amount(Number(summary.winRate) <= 1 ? Number(summary.winRate) * 100 : summary.winRate, 1)}%` : "—");
    setText("source-count", amount(summary.sourceTradeCount, 0));
    setText("copy-count", amount(summary.copyCount, 0));
    setText("filled-count", amount(summary.filledCopies, 0));
    setText("missed-count", amount(summary.missedCopies, 0));
    setText("open-count", amount(summary.openPositions, 0));
    setText("multiplier", finite(snapshot.copier?.multiplier) ? `${amount(snapshot.copier.multiplier, 3)}×` : "—");
    const markCount = Number(summary.markedPositions || 0);
    const openCount = Number(summary.openPositions || 0);
    const markNote = openCount && markCount < openCount
      ? `Open P&L withheld: only ${markCount}/${openCount} positions have a current bid mark.`
      : "Open marks use the best visible bid.";
    const feeNote = summary.feeStatus === "partial"
      ? "Some fee-rate lookups failed; P&L may omit those fees."
      : summary.feeStatus === "estimated"
        ? "Taker fees are estimated from Polymarket's public fee rate; maker rebates are not simulated."
        : "Taker fees are estimated where available; maker rebates are not simulated.";
    setText("accounting-note", `Paper accounting only. ${markNote} ${feeNote}`);
  }

  function renderWatcher(snapshot) {
    const watcher = snapshot.watcher || {};
    setText("wallet-address", compactAddress(snapshot.sourceWallet));
    $("wallet-address").title = snapshot.sourceWallet ? String(snapshot.sourceWallet) : "";
    setText("watcher-status", watcher.status || "—");
    setText("last-poll", formatTime(watcher.lastPollAt, true));
    setText("watcher-lag", finite(watcher.lagMs) ? `${amount(watcher.lagMs, 0)} ms` : "—");
    let warning = $("watcher-warning");
    if (watcher.error) {
      if (!warning) {
        warning = el("p", "watcher-warning");
        warning.id = "watcher-warning";
        $(".wallet-strip").append(warning);
      }
      warning.textContent = `Watcher reports: ${String(watcher.error)}`;
    } else if (warning) warning.remove();
  }

  function setCopier(snapshot) {
    const paused = Boolean(snapshot.copier?.paused);
    setText("copier-state", paused ? "COPIER PAUSED" : "COPIER ACTIVE");
    const button = $("copier-toggle");
    button.textContent = paused ? "Resume paper copies" : "Pause paper copies";
    button.dataset.action = paused ? "resume" : "pause";
    button.disabled = false;
    button.setAttribute("aria-pressed", String(paused));
  }

  function marketCell(title, asset, outcome) {
    const td = el("td", "market-cell");
    const main = el("span", "market-title", title || "Untitled market");
    const parts = [asset, outcome].filter((item) => item !== undefined && item !== null && item !== "");
    td.append(main, el("span", "market-sub", parts.join(" · ") || "—"));
    return td;
  }

  function sideNode(side) {
    const normalized = String(side || "—").toLowerCase();
    return el("span", `trade-side${normalized === "sell" ? " sell" : ""}`, side || "—");
  }

  function sourceSizeLabel(trade) {
    const shares = finite(trade.size) ? `${amount(trade.size)} sh` : "—";
    return finite(trade.usdcSize) ? `${shares} · ${money(trade.usdcSize)}` : shares;
  }

  function sourceTimeLabel(trade) {
    const time = formatTime(trade.timestamp, true);
    return finite(trade.secondsIntoMarket)
      ? `${time} · +${amount(trade.secondsIntoMarket, 0)}s`
      : time;
  }

  function tableEmpty(body, columns, message) {
    const row = el("tr");
    const cell = el("td", "table-state", message);
    cell.colSpan = columns;
    row.append(cell);
    body.replaceChildren(row);
  }

  function mobileEmpty(container, message) {
    container.replaceChildren(el("p", "table-state", message));
  }

  function matching(item) {
    if (state.search && !`${item.marketTitle || ""} ${item.asset || ""} ${item.outcome || ""} ${item.side || ""}`.toLowerCase().includes(state.search)) return false;
    if (state.filter === "source" && item.kind !== "source") return false;
    if (state.filter === "copies" && item.kind !== "copies") return false;
    return true;
  }

  function renderSource(trades) {
    const source = (Array.isArray(trades) ? trades : []).map((trade) => ({ ...trade, kind: "source" })).filter(matching);
    sourceRows.replaceChildren();
    $("source-mobile").replaceChildren();
    if (!source.length) {
      const message = state.search || state.filter === "copies" ? "No source trades match this view." : "No source trades observed yet.";
      tableEmpty(sourceRows, 5, message);
      mobileEmpty($("source-mobile"), message);
      return;
    }
    for (const trade of source) {
      const row = el("tr");
      row.append(
        marketCell(trade.marketTitle, trade.asset, trade.outcome),
        (() => { const td = el("td"); td.append(sideNode(trade.side)); return td; })(),
        el("td", "", finite(trade.price) ? amount(trade.price, 4) : "—"),
        el("td", "", sourceSizeLabel(trade)),
        el("td", "", sourceTimeLabel(trade))
      );
      sourceRows.append(row);

      const card = el("div", "mobile-entry");
      const top = el("div", "mobile-entry-top");
      top.append(marketCell(trade.marketTitle, trade.asset, trade.outcome), sideNode(trade.side));
      const data = el("div", "mobile-entry-data");
      data.append(
        dataPair("Price", finite(trade.price) ? amount(trade.price, 4) : "—"),
        dataPair("Size", sourceSizeLabel(trade)),
        dataPair("Time / window age", sourceTimeLabel(trade))
      );
      card.append(top, data);
      $("source-mobile").append(card);
    }
  }

  function dataPair(label, value) {
    const span = el("span");
    span.append(document.createTextNode(`${label} `), el("b", "", value));
    return span;
  }

  function renderCopies(copies) {
    const rows = (Array.isArray(copies) ? copies : []).map((copy) => ({ ...copy, kind: "copies" })).filter(matching);
    copyRows.replaceChildren();
    $("copy-mobile").replaceChildren();
    if (!rows.length) {
      const message = state.search || state.filter === "source" ? "No paper copies match this view." : "No paper copies processed yet.";
      tableEmpty(copyRows, 5, message);
      mobileEmpty($("copy-mobile"), message);
      return;
    }
    for (const copy of rows) {
      const row = el("tr");
      const requestedFilled = `${amount(copy.requestedShares)} → ${amount(copy.filledShares)}`;
      const priceComparison = `${finite(copy.sourcePrice) ? amount(copy.sourcePrice, 4) : "—"} → ${finite(copy.averagePrice) ? amount(copy.averagePrice, 4) : "—"}`;
      const status = String(copy.status || "—");
      const lag = finite(copy.lagMs) ? `${amount(copy.lagMs, 0)} ms` : "—";
      const feeText = copy.feeStatus === "unavailable" ? "fee unavailable" : `fee ${money(copy.estimatedFees)}`;
      row.append(
        marketCell(copy.marketTitle, copy.asset, copy.outcome),
        (() => { const td = el("td"); td.append(sideNode(copy.side)); return td; })(),
        el("td", "", requestedFilled),
        el("td", "", priceComparison),
        (() => { const td = el("td"); td.append(el("span", `status-pill ${status.toLowerCase()}`, status), document.createTextNode(` ${lag} · ${feeText}`)); return td; })()
      );
      copyRows.append(row);

      const card = el("div", "mobile-entry");
      const top = el("div", "mobile-entry-top");
      top.append(marketCell(copy.marketTitle, copy.asset, copy.outcome), el("span", `status-pill ${status.toLowerCase()}`, status));
      const data = el("div", "mobile-entry-data");
      data.append(
        dataPair("Side", copy.side || "—"),
        dataPair("Requested → filled", requestedFilled),
        dataPair("Source → paper price", priceComparison),
        dataPair("Estimated fee", copy.feeStatus === "unavailable" ? "Unavailable" : money(copy.estimatedFees)),
        dataPair("Lag", lag)
      );
      card.append(top, data);
      $("copy-mobile").append(card);
    }
  }

  function renderPositions(markets) {
    const marketGroups = Array.isArray(markets) ? markets : [];
    setText("position-total", `${marketGroups.length} ${marketGroups.length === 1 ? "market" : "markets"}`);
    positionsList.replaceChildren();
    if (!marketGroups.length) {
      positionsList.append(el("p", "table-state", "No open paper positions."));
      return;
    }
    for (const market of marketGroups) {
      const card = el("article", "market-holdings-card");
      const header = el("div", "market-holdings-header");
      const identity = el("div", "market-holdings-identity");
      identity.append(
        el("strong", "", market.title || "Untitled market"),
        el("small", "", [market.asset, market.slug].filter(Boolean).join(" · ") || "Market window")
      );
      header.append(identity, el("span", `market-holdings-status ${String(market.status || "open").toLowerCase()}`, market.status || "OPEN"));
      card.append(header);

      const sides = el("div", "market-side-grid");
      sides.append(renderHoldingSide("UP", market.up), renderHoldingSide("DOWN", market.down));
      card.append(sides);
      positionsList.append(card);
    }
  }

  function renderHoldingSide(label, side = {}) {
    const box = el("section", `holding-side holding-side-${label.toLowerCase()}`);
    const shares = Number(side.shares) || 0;
    const heading = el("div", "holding-side-heading");
    heading.append(el("strong", "", label), el("span", "", `${amount(shares)} shares`));
    box.append(heading);

    const details = el("div", "holding-side-details");
    details.append(
      positionValue("Average cost", finite(side.averageCost) ? amount(side.averageCost, 4) : "—"),
      positionValue("Mark / bid", finite(side.markBid) ? amount(side.markBid, 4) : "—"),
      positionValue("Market value", money(side.marketValue)),
      positionValue("Open P&L", money(side.unrealizedPnl))
    );
    signedClass(details.lastChild.querySelector("b"), side.unrealizedPnl);
    box.append(details);
    return box;
  }

  function positionValue(label, value) {
    const node = el("div", "position-value");
    node.append(el("span", "", label), el("b", "", value));
    return node;
  }

  function confidence(value) {
    if (!finite(value)) return "Confidence —";
    const n = Number(value);
    return `Sample strength ${amount(n <= 1 ? n * 100 : n, 0)}%`;
  }

  function renderInsights(insights) {
    const patterns = Array.isArray(insights.patterns) ? insights.patterns : [];
    patternsList.replaceChildren();
    if (!patterns.length) patternsList.append(el("p", "table-state", "No heuristic patterns available."));
    for (const pattern of patterns) {
      const row = el("div", "pattern-row");
      const title = el("strong", "", pattern.label || pattern.key || "Unlabeled pattern");
      const score = el("span", "pattern-confidence", confidence(pattern.confidence));
      const description = el("p", "", pattern.description || "No description provided.");
      const supportValue = pattern.support !== undefined && pattern.support !== null ? `Support · ${pattern.support}` : "Support —";
      row.append(title, score, description, el("span", "pattern-support", supportValue));
      patternsList.append(row);
    }
    const sizing = insights.sizing || {};
    setText("sizing-note", [sizing.label, sizing.trend].filter(Boolean).join(" · ") || "Not enough evidence");
    setText("cadence-note", finite(insights.cadence?.medianSeconds) ? `Median ${amount(insights.cadence.medianSeconds, 1)} sec` : "Not enough evidence");
    const orderType = insights.limits?.orderType;
    setText("limits-note", orderType || "Order type details are not exposed by the public feed.");
    const samples = insights.sampleMarkets;
    const sampleCount = Array.isArray(samples) ? samples.length : samples;
    setText("sample-markets", finite(sampleCount) ? `${amount(sampleCount, 0)} sampled markets · heuristics labeled inferred` : "Public market data · heuristics labeled inferred");
  }

  function render(snapshot) {
    state.snapshot = snapshot;
    renderSummary(snapshot);
    renderWatcher(snapshot);
    setCopier(snapshot);
    renderSource(snapshot.recentSourceTrades);
    renderCopies(snapshot.recentCopies);
    renderPositions(snapshot.markets);
    renderInsights(snapshot.insights || {});
    setText("updated-at", `Updated ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date())}`);
    state.loading = false;
  }

  async function loadSnapshot(manual = false) {
    if (manual) setConnection("", "Refreshing");
    try {
      const response = await fetch("/api/snapshot", { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error(`Snapshot request returned ${response.status}`);
      const snapshot = await response.json();
      if (!snapshot || typeof snapshot !== "object") throw new Error("Snapshot response was not valid JSON data.");
      render(snapshot);
      clearError();
      if (manual) showNotice("Snapshot refreshed");
      if (window.eventSource?.readyState === EventSource.OPEN) setConnection("connected", "Live");
      else setConnection("", "Connected · polling");
    } catch (error) {
      setConnection("disconnected", "Snapshot unavailable");
      showError(`Could not load the live snapshot. ${error?.message || "Check the connection and retry."}`);
      if (manual) showNotice("Refresh failed — retry when connected");
    }
  }

  async function toggleCopier() {
    const button = $("copier-toggle");
    if (!state.snapshot || button.disabled) return;
    const action = button.dataset.action;
    button.disabled = true;
    button.textContent = action === "pause" ? "Pausing…" : "Resuming…";
    try {
      const response = await fetch(`/api/copier/${action}`, {
        method: "POST",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error(`Request returned ${response.status}`);
      showNotice(action === "pause" ? "Paper-copy processing paused" : "Paper-copy processing resumed");
      await loadSnapshot();
    } catch (error) {
      button.disabled = false;
      setCopier(state.snapshot);
      showNotice(`Could not ${action} paper copies. ${error?.message || "Try again."}`);
    }
  }

  function attachStream() {
    if (!("EventSource" in window)) {
      setConnection("", "Connected · polling");
      window.setInterval(() => loadSnapshot(), 15000);
      return;
    }
    const stream = new EventSource("/api/events");
    window.eventSource = stream;
    stream.onopen = () => {
      setConnection("connected", "Live");
      clearError();
      loadSnapshot();
    };
    stream.onmessage = () => scheduleRefresh();
    for (const type of ["snapshot", "update", "state", "change"]) stream.addEventListener(type, scheduleRefresh);
    stream.onerror = () => {
      setConnection("disconnected", "Reconnecting");
      if (!state.snapshot) showError("Live event stream disconnected. Reconnecting automatically; you can retry the snapshot.");
      if (!state.refreshTimer) loadSnapshot();
    };
  }

  function scheduleRefresh() {
    if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => {
      state.refreshTimer = null;
      loadSnapshot();
    }, 120);
  }

  $("refresh-button").addEventListener("click", () => loadSnapshot(true));
  $("copier-toggle").addEventListener("click", toggleCopier);
  $("activity-search").addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase();
    if (state.snapshot) {
      renderSource(state.snapshot.recentSourceTrades);
      renderCopies(state.snapshot.recentCopies);
    }
  });
  document.querySelectorAll(".segment").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      document.querySelectorAll(".segment").forEach((item) => item.classList.toggle("active", item === button));
      if (state.snapshot) {
        renderSource(state.snapshot.recentSourceTrades);
        renderCopies(state.snapshot.recentCopies);
      }
    });
  });

  loadSnapshot();
  attachStream();
  window.setInterval(() => loadSnapshot(), 30000);
})();

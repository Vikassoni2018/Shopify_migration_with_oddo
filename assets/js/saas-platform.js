(function () {
  function normalizePath(pathname) {
    return String(pathname || "/").replace(/\/+$/, "") || "/";
  }

  function getAppConfig() {
    return window.APP_CONFIG || {};
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getApiBase() {
    var config = getAppConfig();
    return String(
      config.defaultApiBaseUrl ||
      config.publicBaseUrl ||
      config.localApiBaseUrl ||
      ""
    ).replace(/\/+$/, "");
  }

  function toApiUrl(pathname) {
    var base = getApiBase();
    if (!pathname) {
      return base || "/";
    }
    return base ? base + pathname : pathname;
  }

  async function requestJson(pathname, options) {
    var response = await fetch(toApiUrl(pathname), options || {});
    var payload;

    try {
      payload = await response.json();
    } catch (error) {
      payload = { ok: false, error: "Invalid server response." };
    }

    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || ("Request failed with status " + response.status));
    }

    return payload;
  }

  function formatInteger(value) {
    var number = Number(value || 0);
    if (!Number.isFinite(number)) {
      return "0";
    }
    return number.toLocaleString("en-US");
  }

  function formatCurrency(value) {
    var number = Number(value || 0);
    if (!Number.isFinite(number)) {
      return "$0.00";
    }
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(number);
  }

  function initMobileNav() {
    var toggle = document.querySelector("[data-nav-toggle]");
    var menu = document.querySelector("[data-mobile-nav]");

    if (!toggle || !menu) {
      return;
    }

    toggle.addEventListener("click", function () {
      menu.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", menu.classList.contains("is-open") ? "true" : "false");
    });

    menu.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        menu.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  function initActiveNav() {
    var current = normalizePath(window.location.pathname);

    document.querySelectorAll("[data-route]").forEach(function (link) {
      var route = normalizePath(link.getAttribute("data-route"));
      var startsWith = link.hasAttribute("data-route-prefix");
      var isActive = route === "/"
        ? current === "/"
        : startsWith
          ? current.indexOf(route) === 0
          : current === route;

      if (isActive) {
        link.classList.add("is-active");
      }
    });
  }

  function initFaq() {
    document.querySelectorAll("[data-faq-toggle]").forEach(function (button) {
      button.addEventListener("click", function () {
        var item = button.closest(".faq-item");
        if (!item) {
          return;
        }
        item.classList.toggle("is-open");
      });
    });
  }

  function initFooterYear() {
    document.querySelectorAll("[data-current-year]").forEach(function (node) {
      node.textContent = String(new Date().getFullYear());
    });
  }

  function readQuery() {
    return new URLSearchParams(window.location.search || "");
  }

  window.PlatformApp = {
    getAppConfig: getAppConfig,
    getApiBase: getApiBase,
    toApiUrl: toApiUrl,
    requestJson: requestJson,
    escapeHtml: escapeHtml,
    formatInteger: formatInteger,
    formatCurrency: formatCurrency,
    readQuery: readQuery
  };

  document.addEventListener("DOMContentLoaded", function () {
    initMobileNav();
    initActiveNav();
    initFaq();
    initFooterYear();
  });
}());

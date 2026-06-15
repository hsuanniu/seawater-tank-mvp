(function bootstrapModuleApp() {
  const moduleSrc = "app.module.js?v=20260615-hide-cloud-nav";
  const alreadyLoaded = Array.from(document.scripts).some((script) => script.src.includes("app.module.js"));
  if (alreadyLoaded) return;

  const script = document.createElement("script");
  script.type = "module";
  script.src = moduleSrc;
  script.onerror = () => {
    const toast = document.querySelector("#toast");
    if (toast) {
      toast.textContent = "新版程式載入失敗，請重新整理頁面。";
      toast.classList.add("show");
    }
  };
  document.head.appendChild(script);
})();

const personas = [...document.querySelectorAll("[data-agent]")];
const responses = [...document.querySelectorAll("[data-response]")];

for (const persona of personas) {
  persona.addEventListener("click", () => {
    const selected = persona.dataset.agent;
    for (const item of personas) item.classList.toggle("active", item === persona);
    for (const response of responses) {
      response.classList.toggle("active", response.dataset.response === selected);
    }
  });
}

document.querySelector("#copy-install")?.addEventListener("click", async (event) => {
  await navigator.clipboard.writeText("npm i -g @susyimes/groupx");
  const button = event.currentTarget;
  button.textContent = "已复制";
  setTimeout(() => { button.textContent = "复制"; }, 1600);
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import { render } from "solid-js/web";
import "./styles/app.css";
import App from "./App";
import { StoreProvider } from "./lib/store";
import { dismissSplash } from "./lib/boot";

const root = document.getElementById("root");
render(() => <StoreProvider><App /></StoreProvider>, root!);
window.setTimeout(dismissSplash, 5000); // 兜底：任何启动异常都不允许骨架卡死

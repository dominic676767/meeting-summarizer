import { createZoomAdapter } from "../adapters/zoom";
import { mountContentScript } from "./mount";

mountContentScript(createZoomAdapter());

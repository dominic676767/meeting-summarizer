import { createTeamsAdapter } from "../adapters/teams";
import { mountContentScript } from "./mount";

mountContentScript(createTeamsAdapter());

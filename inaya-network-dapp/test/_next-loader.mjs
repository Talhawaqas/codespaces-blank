// Lets plain Node import the API route files, which import "next/server"
// (Next's bundler resolves that; Node needs the file extension).
import { register } from "node:module";
register("./_next-hooks.mjs", import.meta.url);

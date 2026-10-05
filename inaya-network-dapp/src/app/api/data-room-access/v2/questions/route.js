// GET -> this visitor's own questions and answers;  POST { documentId?, text } -> ask a question
import * as V from "../../../../../lib/dataroom/vdr2.js";
import { visitor } from "../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req) => visitor(req, ({ token }) => V.listMyQuestions({ token }));
export const POST = (req) => visitor(req, ({ token, body }) => V.askQuestion({ token, documentId: body.documentId, text: body.text }));

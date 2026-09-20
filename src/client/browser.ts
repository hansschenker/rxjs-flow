import { mountTodoApp } from './main';
import './todo.css';

// This executable entry is the only module that activates the browser app.
export const app = mountTodoApp(document, { hot: import.meta.hot });
export { mountTodoApp } from './main';
// Diagnostic construction stays inert; the host explicitly opts in on remount.
export { createTrace, createTraceRecorder } from '../shared/trace';
import.meta.hot?.accept();

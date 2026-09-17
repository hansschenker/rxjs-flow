import { mountTodoApp } from './main';
import './todo.css';

// This executable entry is the only module that activates the browser app.
mountTodoApp(document, { hot: import.meta.hot });
import.meta.hot?.accept();

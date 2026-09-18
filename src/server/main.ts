import { createApp } from './core/app';
import { logger, requestId } from './core/middleware';
import { createTodoRoutes } from './todos/todo.routes';
import { createTodoStore } from './todos/todo.store-factory';

const app = createApp(createTodoRoutes(), {
	services: {
		todoStore: createTodoStore(),
	},
	middlewares: [requestId(), logger()],
});

void app.start(3000);

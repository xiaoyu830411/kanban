/**
 * 内核公共 API。内核只含核心域（任务、看板、认领、空间、成员），
 * 不依赖任何具体插件（ADR-0004）——插件经 PluginHost 由组合根注册。
 */
export * from './board-columns';
export * from './events';
export * from './event-bus';
export * from './plugin';

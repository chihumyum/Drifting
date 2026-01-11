这个文档不需要修改。这是我个人的记录文档。

架构：
electron客户端
nodejs 后端 - fastify?
drizzle ORM - 客户端和后端

客户端sqlite 内置FTS5倒排索引+多语言分词 - 需要materialized content投影支持全局搜索
    所有prosemirror content都yjs 包装成state，用于crdt

content同步用CRDT - yjs + HTTP pull push - 无需websocket
	需要自己写本地的provider和同步用的provider
    CRDT 在 server端diff开销大，暂时起worker thread应付。
        更新：改为server存增量log，push直接落库，pull拿增量client自己apply
postgres后端主要数据库，存的东西和sqlite一致，除了content投影。增量同步。
非content的内容暂定LWW，时间戳+软删除

Time Machine：本地sqlite存索引+硬盘压缩immutable
on device LLM 来提供copilot能力，实现快速ai hint，像IDE代码补全一样

redis 异步队列，rate limit，分布式锁，api缓存，用一层redis来锻炼后端能力
    如果redis不够用，加一个MQ

betterAuth鉴权+Google之类的oAuth支持
stripe  + ... 收款
GT general translation 自动翻译


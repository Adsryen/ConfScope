# 搜索服务 - 生产 (QA 预演)
app:
  name: search-svc
  # 环境标记
  env: prod

# 排序（生产把 rank 提前, oncall 常看）
rank:
  # 生产多因子
  factors:
    - relevance
    - sales
    - review-score
  # 生产启用商业加权
  commercial-boost: true

elasticsearch:
  # 生产三节点
  nodes:
    - http://es-1.search.internal:9200
    - http://es-2.search.internal:9200
    - http://es-3.search.internal:9200
  # 生产索引
  index: search-prod
  # 生产开 IK 中文分词
  ik:
    enabled: true

# 召回策略
recall:
  # 生产改为布尔 true（开发侧仍是字符串 "true", 类型不一致!）
  fuzzy: true
  min-should-match: 6
  synonyms:
    - phone -> mobile, cell
    - 电脑 -> computer
    # 生产新增汽车同义词
    - car -> automobile, vehicle

# 缓存（生产 Redis 集群）
cache:
  type: redis
  # 生产 10 分钟
  ttl-seconds: 600

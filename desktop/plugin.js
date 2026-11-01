import { useState, useEffect, useCallback, useRef } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'model-cache'

function ModelGroup({ model, action, rest }) {
  const isPromote = action === 'promote'
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const quants = model.quants || []
  const quantSizes = model.quant_sizes || {}

  const doPromote = async (quant) => {
    setLoading(true)
    try {
      await rest('/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model.dir,
          action: 'promote',
          quant
        })
      })
    } finally {
      setLoading(false)
    }
  }

  const doEvict = async (quant) => {
    setLoading(true)
    try {
      await rest('/evict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model.dir,
          action: 'evict',
          quant
        })
      })
    } finally {
      setLoading(false)
    }
  }

  return jsxs('div', {
    className: 'border-b border-(--ui-border-subtle)',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2 px-2 py-1.5 text-xs hover:bg-(--chrome-action-hover)',
        children: [
          jsxs('div', {
            className: 'flex-1 truncate flex items-center gap-1 cursor-pointer',
            onClick: () => setExpanded(!expanded),
            children: [
              jsx('span', { className: 'text-(--ui-text-quaternary) text-[10px]', children: expanded ? '▼' : '▶' }),
              jsx('span', { className: 'font-medium', children: model.name }),
              jsx('span', { className: 'ml-2 text-(--ui-text-quaternary)', children: model.size }),
              jsx('span', { className: 'ml-2 text-(--ui-text-quaternary) text-[10px]', children: `(${quants.length} quant${quants.length !== 1 ? 's' : ''})` }),
            ]
          }),
          jsxs('div', {
            className: 'flex items-center gap-1',
            children: [
              jsx('button', {
                type: 'button',
                className: 'px-2 py-0.5 text-[10px] rounded bg-(--accent) text-(--accent-foreground) hover:opacity-80 disabled:opacity-50',
                disabled: loading,
                onClick: () => (isPromote ? doPromote() : doEvict()),
                children: loading ? '…' : (isPromote ? 'Promote All' : 'Evict All')
              }),
            ]
          })
        ]
      }),
      expanded ? jsxs('div', {
        className: 'pl-6 pb-1',
        children: quants.length > 0
          ? quants.map(q => jsxs('div', {
              key: q,
              className: 'flex items-center justify-between gap-2 px-2 py-0.5 text-[11px] hover:bg-(--chrome-action-hover)',
              children: [
                jsxs('div', {
                  className: 'flex-1 truncate',
                  children: [
                    jsx('span', { children: q }),
                    jsx('span', { className: 'ml-2 text-(--ui-text-quaternary)', children: quantSizes[q] || '' }),
                  ]
                }),
                jsx('button', {
                  type: 'button',
                  className: 'px-2 py-0.5 text-[10px] rounded bg-(--accent) text-(--accent-foreground) hover:opacity-80 disabled:opacity-50',
                  disabled: loading,
                  onClick: () => (isPromote ? doPromote(q) : doEvict(q)),
                  children: loading ? '…' : (isPromote ? `Promote ${q}` : `Evict ${q}`)
                }),
              ]
            }))
          : jsx('div', { className: 'px-2 py-0.5 text-[11px] text-(--ui-text-quaternary)', children: 'No .gguf files found' })
      }) : null
    ]
  })
}

function ModelCachePane({ rest }) {
  const [statusData, setStatusData] = useState({})
  const [coldModels, setColdModels] = useState([])
  const [hotModels, setHotModels] = useState([])
  const [refreshing, setRefreshing] = useState(false)
  const fetchingRef = useRef(false)
  const restRef = useRef(rest)

  useEffect(() => {
    restRef.current = rest
  }, [rest])

  const fetchAll = useCallback(async () => {
    if (fetchingRef.current) return
    fetchingRef.current = true
    setColdModels([])
    setHotModels([])
    try {
      const [s, c, h] = await Promise.all([
        restRef.current('/status', { method: 'GET' }).catch(() => null),
        restRef.current('/cold', { method: 'GET' }).catch(() => null),
        restRef.current('/hot', { method: 'GET' }).catch(() => null)
      ])

      const coldList = (c && c.models) ? c.models : []
      const hotList = (h && h.models) ? h.models : []
      const normalizedCold = coldList.map(m => ({
        ...m,
        quants: m.quants || m.ggufs || [],
        quant_sizes: m.quant_sizes || {},
      }))
      const uniqueCold = Array.from(
        new Map(normalizedCold.filter(m => m && m.dir).map(m => [m.dir, m])).values()
      )
      const uniqueHot = Array.from(
        new Map(hotList.filter(m => m && m.dir).map(m => [m.dir, m])).values()
      )
      setStatusData(s || {})
      setColdModels(uniqueCold)
      setHotModels(uniqueHot)
    } catch (e) {
      console.error("Failed to fetch cache data", e)
    } finally {
      fetchingRef.current = false
    }
  }, [])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const handleRefresh = async () => {
    setRefreshing(true)
    await fetchAll()
    setTimeout(() => setRefreshing(false), 800)
  }

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 p-3 text-sm overflow-auto',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between text-xs text-(--ui-text-tertiary)',
        children: [
          jsx('span', { children: `v0.1.22 | Cold: ${statusData.cold_size || '?'} | Hot: ${statusData.hot_size || '?'}` }),
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx('span', { children: `Free: ${statusData.cache_free || '?'} (${statusData.cache_pct || '?'})` }),
              jsx('button', {
                type: 'button',
                className: `w-5 h-5 flex items-center justify-center rounded-full text-(--ui-text-tertiary) hover:text-(--ui-text-primary) border border-(--ui-stroke-secondary) text-[12px] leading-none ${refreshing ? 'animate-spin' : ''}`,
                onClick: handleRefresh,
                disabled: refreshing,
                children: '↻'
              }),
            ]
          }),
        ]
      }),
      jsx('div', {
        className: 'text-xs font-medium text-(--ui-text-secondary) mt-2',
        children: `Cold (Array) — ${coldModels.length} models`
      }),
      coldModels.map(m => jsx(ModelGroup, { key: m.dir, model: m, action: 'promote', rest: restRef.current }, null)),
      jsx('div', {
        className: 'text-xs font-medium text-(--ui-text-secondary) mt-2',
        children: `Hot (NVMe) — ${hotModels.length} models`
      }),
      hotModels.map(m => jsx(ModelGroup, { key: m.dir, model: m, action: 'evict', rest: restRef.current }, null)),
    ]
  })
}
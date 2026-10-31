import { cn, host, useQuery, useMutation, useQueryClient } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'model-cache'

function SpaceBar({ used, total }) {
  return jsxs('div', {
    className: 'flex items-center gap-2 text-xs text-(--ui-text-tertiary)',
    children: [
      jsx('span', { children: `Cache: ${used} / ${total}` }),
    ]
  })
}

function ModelRow({ model, onPromote, onEvict, isHot }) {
  return jsxs('div', {
    className: 'flex items-center justify-between gap-2 px-2 py-1 text-xs hover:bg-(--chrome-action-hover)',
    children: [
      jsxs('div', {
        className: 'flex-1 truncate',
        children: [
          jsx('span', { className: 'font-medium', children: model.name }),
          jsx('span', { className: 'ml-2 text-(--ui-text-quaternary)', children: model.size }),
        ]
      }),
      isHot
        ? jsx('button', {
            className: 'px-2 py-0.5 rounded text-(--ui-text-tertiary) hover:text-red-400',
            onClick: () => onEvict(model.dir),
            children: 'evict'
          })
        : jsx('button', {
            className: 'px-2 py-0.5 rounded text-(--ui-text-tertiary) hover:text-green-400',
            onClick: () => onPromote(model.dir),
            children: 'promote'
          })
    ]
  })
}

function ModelCachePane() {
  const qc = useQueryClient()

  const status = useQuery({
    queryKey: ['mc-status'],
    queryFn: () => host.request('plugin.rest', { path: '/status', method: 'GET' }),
    refetchInterval: 10000,
  })

  const cold = useQuery({
    queryKey: ['mc-cold'],
    queryFn: () => host.request('plugin.rest', { path: '/cold', method: 'GET' }),
    refetchInterval: 30000,
  })

  const hot = useQuery({
    queryKey: ['mc-hot'],
    queryFn: () => host.request('plugin.rest', { path: '/hot', method: 'GET' }),
    refetchInterval: 30000,
  })

  const promoteMut = useMutation({
    mutationFn: (dir) => host.request('plugin.rest', { path: '/promote', method: 'POST', body: { model: dir } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['mc-hot'] }); qc.invalidateQueries({ queryKey: ['mc-status'] }) },
  })

  const evictMut = useMutation({
    mutationFn: (dir) => host.request('plugin.rest', { path: '/evict', method: 'POST', body: { model: dir } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['mc-hot'] }); qc.invalidateQueries({ queryKey: ['mc-status'] }) },
  })

  const statusData = status.data || {}
  const coldModels = cold.data?.models || []
  const hotModels = hot.data?.models || []

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 p-3 text-sm overflow-auto',
    children: [
      // Status bar
      jsxs('div', {
        className: 'flex items-center justify-between text-xs text-(--ui-text-tertiary)',
        children: [
          jsx('span', { children: `Cold: ${statusData.cold_size || '?'} | Hot: ${statusData.hot_size || '?'}` }),
          jsx('span', { children: `Free: ${statusData.cache_free || '?'} (${statusData.cache_pct || '?'})` }),
        ]
      }),
      // Hot cache
      jsx('div', {
        className: 'text-xs font-medium text-(--ui-text-secondary) mt-2',
        children: `Hot (NVMe) — ${hotModels.length} models`
      }),
      ...hotModels.map(m => jsx(ModelRow, {
        key: m.dir,
        model: m,
        isHot: true,
        onEvict: (dir) => evictMut.mutate(dir),
      })),
      // Cold storage
      jsx('div', {
        className: 'text-xs font-medium text-(--ui-text-secondary) mt-2',
        children: `Cold (Array) — ${coldModels.length} models`
      }),
      ...coldModels.map(m => jsx(ModelRow, {
        key: m.dir,
        model: m,
        isHot: false,
        onPromote: (dir) => promoteMut.mutate(dir),
      })),
    ]
  })
}

export default {
  id: ID,
  name: 'Model Cache',
  register(ctx) {
    ctx.i18n.register({
      en: {
        paneTitle: 'Model Cache Tier',
      }
    })

    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'model cache',
      data: { placement: 'right', width: '320px' },
      render: () => jsx(ModelCachePane, {})
    })
  }
}

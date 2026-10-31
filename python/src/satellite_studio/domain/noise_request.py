"""A renderer-independent immutable dependency manifest."""
from dataclasses import dataclass, asdict
import re
from .parameters import Noise, integer, mapping

@dataclass(frozen=True)
class NoiseVariantRequest:
    source_job_id: str
    count: int
    noise: Noise
    seed: int
    source_snapshot_sha256: str
    mode: str = 'noise_variant'

    @staticmethod
    def parse_body(values: dict) -> tuple[Noise, int]:
        values = mapping(values, 'noise_variant')
        if set(values) != {'noise', 'seed'}:
            raise ValueError('追加噪声请求只接受 noise 和 seed')
        raw = mapping(values['noise'], 'noise')
        if raw.get('enabled') is not True or set(raw) - {'enabled','gaussian_sigma','poisson_peak'}:
            raise ValueError('noise 必须 enabled=true 且仅包含已知噪声参数')
        return Noise.from_dict(raw), integer(values['seed'], 'seed', 0, 2**32-1)

    @classmethod
    def from_dict(cls, values: dict):
        values = mapping(values, 'noise_variant')
        if set(values) != {'source_job_id','count','noise','seed','source_snapshot_sha256','mode'} or values['mode'] != 'noise_variant':
            raise ValueError('噪声依赖清单结构错误')
        noise, seed = cls.parse_body({k:values[k] for k in ('noise','seed')})
        source, digest = values['source_job_id'], values['source_snapshot_sha256']
        if not isinstance(source,str) or not re.fullmatch('[a-f0-9]{32}',source) or not isinstance(digest,str) or not re.fullmatch('[a-f0-9]{64}',digest):
            raise ValueError('噪声来源标识或快照摘要错误')
        return cls(source, integer(values['count'],'count',1,100000), noise, seed, digest)

    def to_dict(self):
        return asdict(self)

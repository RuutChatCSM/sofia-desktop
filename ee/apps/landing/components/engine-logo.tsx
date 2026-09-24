import Image from "next/image";

type Props = {
  className?: string;
};

export function SofiaLogo(props: Props) {
  return (
    <Image
      src="/engine-wordmark.svg"
      alt=""
      aria-hidden="true"
      className={props.className}
      width={234}
      height={42}
      unoptimized
    />
  );
}
